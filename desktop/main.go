package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gin-gonic/gin"
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

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPListener).Port)
	log.Printf("无限画布桌面版已启动：%s", url)
	openBrowser(url)
	if err := http.Serve(listener, engine); err != nil {
		log.Fatal(err)
	}
}

// desktopStaticHandler 优先返回命中的静态文件；未命中时按 Next 静态导出的文件名规则回退，
// 保证刷新或直接输入地址时页面可用。
func desktopStaticHandler(dist fs.FS) gin.HandlerFunc {
	fileServer := http.FileServer(http.FS(dist))
	try := func(c *gin.Context, path string) bool {
		path = strings.TrimPrefix(path, "/")
		if path == "" {
			return false
		}
		if stat, err := fs.Stat(dist, path); err == nil && !stat.IsDir() {
			c.Request.URL.Path = "/" + path
			fileServer.ServeHTTP(c.Writer, c.Request)
			return true
		}
		return false
	}
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/api/") || path == "/api" {
			c.JSON(http.StatusNotFound, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
			return
		}
		candidates := []string{path, path + ".html", filepath.ToSlash(filepath.Join(path, "index.html"))}
		for _, candidate := range candidates {
			if try(c, candidate) {
				return
			}
		}
		// 未知路径回退：/canvas/*（旧地址或未带的参数）回画布页，其余回首页
		fallback := "/index.html"
		if strings.HasPrefix(path, "/canvas") {
			fallback = "/canvas.html"
		}
		if !try(c, fallback) {
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
