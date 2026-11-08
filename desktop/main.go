//go:build windows

package main

import (
	"bytes"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	webview2 "github.com/jchv/go-webview2"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

// dist 为前端静态导出产物（构建脚本会把 web/out 拷贝到这里）
//
//go:embed all:dist
var distFS embed.FS

func main() {
	// WebView2 窗口必须运行在主 OS 线程
	runtime.LockOSThread()

	// 启用 GPU 光栅化与零拷贝合成：大画布平移/缩放由 GPU 合成，降低 CPU 合成瓶颈。
	// WebView2 加载器在创建环境前读取该环境变量；用户已手动设置时尊重用户值。
	if os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") == "" {
		os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--enable-gpu-rasterization --enable-zero-copy")
	}

	// 数据目录锚定到 exe 所在目录，保证便携性
	if exePath, err := os.Executable(); err == nil {
		_ = os.Chdir(filepath.Dir(exePath))
	}

	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAgentSkills(); err != nil {
		log.Fatal(err)
	}
	service.StartPromptSyncScheduler()
	service.StartCanvasProjectCleanupScheduler()
	handler.StartVideoTaskPoller()
	service.WakeComfyBridgePoller()

	dist, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal(err)
	}

	engine := router.New()
	engine.NoRoute(desktopStaticHandler(dist))

	// 端口决定 WebView2 的页面 origin，而 IndexedDB / localStorage 都按 origin 隔离。
	// 老实现每次启动都用 127.0.0.1:0 随机端口，等于每开一次就是一个全新的本地存储，
	// 画布项目、图片 blob、配置全部"消失"——这也是导入后进不去画布的直接原因之一。
	// 现在固定端口：优先复用上次成功监听的端口，其次 36512 起逐个尝试。
	listener, port := listenDesktop()
	url := fmt.Sprintf("http://127.0.0.1:%d", port)

	go func() {
		if err := http.Serve(listener, engine); err != nil {
			log.Printf("服务退出：%v", err)
		}
	}()
	waitForServer(url)
	log.Printf("本地服务已就绪：%s", url)

	// 独立应用窗口（WebView2）；不可用时回退系统浏览器
	if openWindow(url) {
		log.Printf("无限画布桌面版已启动：%s", url)
		return
	}
	log.Printf("WebView2 不可用，已回退浏览器模式：%s", url)
	openBrowser(url)
	select {} // 保持服务运行
}

// openWindow 打开独立应用窗口并阻塞直到窗口关闭；WebView2 初始化失败时返回 false
func openWindow(url string) (opened bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("WebView2 初始化失败：%v", r)
			opened = false
		}
	}()
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		// 画布项目和生成的图片都存在 IndexedDB 里，默认会写到 C:\Users\<用户>\AppData，
		// 生成的图多了很快把 C 盘吃满。这里固定到 exe 同级的 userdata 目录。
		DataPath: prepareWebViewDataPath(),
		WindowOptions: webview2.WindowOptions{
			Title:  "无限画布",
			Width:  1440,
			Height: 900,
			Center: true,
		},
	})
	if w == nil {
		return false
	}
	w.SetTitle("无限画布")
	w.Navigate(url)
	w.Run()
	w.Destroy()
	return true
}

const defaultDesktopPort = 36512
const desktopPortFile = "desktop-port.txt"
const webViewDataDir = "userdata"

// prepareWebViewDataPath 把 WebView2 的用户数据目录（画布 IndexedDB、图片 blob、HTTP 缓存）
// 固定到 exe 同级的 userdata 目录，避免占满 C 盘；首次启动时把旧版本留在
// %AppData%\<exe 名> 下的数据整体迁移过来，避免升级后画布"消失"。
func prepareWebViewDataPath() string {
	legacy := ""
	if exePath, err := os.Executable(); err == nil {
		legacy = filepath.Join(os.Getenv("AppData"), filepath.Base(exePath))
	}
	if _, err := os.Stat(webViewDataDir); os.IsNotExist(err) && legacy != "" {
		if info, statErr := os.Stat(legacy); statErr == nil && info.IsDir() {
			log.Printf("正在把旧数据目录迁移到程序目录：%s → %s", legacy, webViewDataDir)
			if renameErr := os.Rename(legacy, webViewDataDir); renameErr != nil {
				// 跨盘符无法直接 rename，退化成复制；复制失败就继续用旧目录，绝不丢数据
				if copyErr := copyDir(legacy, webViewDataDir); copyErr != nil {
					log.Printf("迁移失败，继续使用旧目录：%v", copyErr)
					_ = os.RemoveAll(webViewDataDir)
					return legacy
				}
				if removeErr := os.RemoveAll(legacy); removeErr != nil {
					log.Printf("旧数据目录未能删除，可手动清理：%s（%v）", legacy, removeErr)
				}
			}
			log.Printf("数据目录已就绪：%s", webViewDataDir)
		}
	}
	if err := os.MkdirAll(webViewDataDir, 0o755); err != nil {
		return ""
	}
	abs, err := filepath.Abs(webViewDataDir)
	if err != nil {
		return webViewDataDir
	}
	return abs
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(src, path)
		if relErr != nil {
			return relErr
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		source, openErr := os.Open(path)
		if openErr != nil {
			return openErr
		}
		defer source.Close()
		destination, createErr := os.Create(target)
		if createErr != nil {
			return createErr
		}
		defer destination.Close()
		_, copyErr := io.Copy(destination, source)
		return copyErr
	})
}

// listenDesktop 以固定端口启动本地服务，保证 WebView2 的 origin 稳定，
// 这样 IndexedDB 里的画布数据和图片才能真正持久化。
func listenDesktop() (net.Listener, int) {
	if port := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_PORT")); port != "" {
		listener, err := net.Listen("tcp", "127.0.0.1:"+port)
		if err != nil {
			log.Fatalf("监听端口 %s 失败：%v", port, err)
		}
		return listener, listenerPort(listener)
	}

	candidates := make([]int, 0, 24)
	if port := readPortFile(); port > 0 {
		candidates = append(candidates, port)
	}
	candidates = append(candidates, defaultDesktopPort)
	for port := defaultDesktopPort + 1; port <= defaultDesktopPort+16; port++ {
		candidates = append(candidates, port)
	}

	seen := make(map[int]bool, len(candidates))
	for _, port := range candidates {
		if seen[port] {
			continue
		}
		seen[port] = true
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		actual := listenerPort(listener)
		writePortFile(actual)
		return listener, actual
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	actual := listenerPort(listener)
	// 临时端口绝不能写回端口文件：WebView2 的 IndexedDB / localStorage 按 origin（含端口）隔离，
	// 写回会让以后每次启动都停在临时端口，用户会看到画布"全没了"。
	log.Printf("固定端口均被占用，本次改用临时端口 %d；画布数据仍在原端口对应的存储中，关闭占用端口的程序后重启即可恢复", actual)
	return listener, actual
}

func listenerPort(listener net.Listener) int {
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		log.Fatal("unexpected listener address")
	}
	return addr.Port
}

func readPortFile() int {
	data, err := os.ReadFile(desktopPortFile)
	if err != nil {
		return 0
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

func writePortFile(port int) {
	_ = os.WriteFile(desktopPortFile, []byte(strconv.Itoa(port)), 0o644)
}

// waitForServer 轮询等待本地服务就绪，最多 10 秒
func waitForServer(url string) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url + "/api/health")
		if err == nil {
			_ = resp.Body.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// desktopStaticHandler 优先返回命中的静态文件；未命中时按 Next 静态导出的文件名规则回退，
// 保证刷新或直接输入地址时页面可用。文件直接读取返回，避免 FileServer 对 index.html 的重定向。
func desktopStaticHandler(dist fs.FS) gin.HandlerFunc {
	serve := func(c *gin.Context, path string) bool {
		path = strings.TrimPrefix(path, "/")
		if path == "" {
			return false
		}
		data, err := fs.ReadFile(dist, path)
		if err != nil {
			return false
		}
		http.ServeContent(c.Writer, c.Request, filepath.Base(path), time.Time{}, bytes.NewReader(data))
		return true
	}
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/api/") || path == "/api" {
			c.JSON(http.StatusNotFound, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
			return
		}
		if serve(c, strings.TrimPrefix(path, "/")) {
			return
		}
		for _, candidate := range []string{path + ".html", path + "/index.html"} {
			if serve(c, candidate) {
				return
			}
		}
		// 未知路径回退：/canvas/*（旧地址或未带的参数）回画布页，其余回首页
		fallback := "/index.html"
		if strings.HasPrefix(path, "/canvas") {
			fallback = "/canvas.html"
		}
		if !serve(c, fallback) {
			c.JSON(http.StatusNotFound, gin.H{"code": 1, "data": nil, "msg": "页面不存在"})
		}
	}
}

func openBrowser(url string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	if err := command.Start(); err != nil {
		log.Printf("请手动在浏览器打开：%s", url)
	}
}
