// canvas-cli：给 AI 使用的独立生图 / 审稿命令行，自带渠道配置，独立于画布主程序运行。
// 所有命令输出 JSON（成功 {"ok":true,...}，失败 {"ok":false,"error":"..."} 且退出码 1）。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const defaultOutDir = "canvas-cli-output"

type Config struct {
	Protocol       string `json:"protocol"`
	BaseURL        string `json:"baseUrl"`
	APIKey         string `json:"apiKey"`
	ImageModel     string `json:"imageModel"`
	ReviewModel    string `json:"reviewModel,omitempty"`
	ReviewBaseURL  string `json:"reviewBaseUrl,omitempty"`
	ReviewAPIKey   string `json:"reviewApiKey,omitempty"`
	Size           string `json:"size"`
	Quality        string `json:"quality"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

func defaultConfig() Config {
	return Config{
		Protocol:       "openai",
		BaseURL:        "https://api.openai.com",
		ImageModel:     "gpt-image-2",
		Size:           "1:1",
		Quality:        "auto",
		TimeoutSeconds: 600,
	}
}

func configPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		failf("读取用户目录失败：%v", err)
	}
	return filepath.Join(home, ".infinite-canvas", "canvas-cli.json")
}

func loadConfig() Config {
	cfg := defaultConfig()
	if data, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	if v := strings.TrimSpace(os.Getenv("CANVAS_CLI_BASE_URL")); v != "" {
		cfg.BaseURL = v
	}
	if v := strings.TrimSpace(os.Getenv("CANVAS_CLI_API_KEY")); v != "" {
		cfg.APIKey = v
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 600
	}
	return cfg
}

func emit(v any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(v)
}

func failf(format string, args ...any) {
	emit(map[string]any{"ok": false, "error": fmt.Sprintf(format, args...)})
	os.Exit(1)
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) {
	if err := fs.Parse(args); err != nil {
		failf("参数错误：%v（执行 canvas-cli help 查看用法）", err)
	}
}

const usageText = `canvas-cli：AI 自动生图 / 审稿命令行（独立于画布主程序）

用法：
  canvas-cli config set [--protocol openai|gemini] [--base-url URL] [--api-key KEY]
                        [--image-model M] [--review-model M] [--review-base-url URL]
                        [--review-api-key KEY] [--size 1:1|1024x1024]
                        [--quality auto|low|medium|high] [--timeout 秒]
  canvas-cli config show
  canvas-cli generate --prompt "提示词" [--out DIR] [--n 2] [--size 1:1] [--quality high]
                      [--model M] [--ref 图1.png --ref 图2.png] [--prefix name]
  canvas-cli list [--out DIR] [--status pending|approved|rejected]
  canvas-cli review --file 文件.png --status approved|rejected [--score 8] [--note "意见"] [--out DIR]
  canvas-cli auto-review [--out DIR] [--min-score 7] [--limit 10] [--extra "附加审稿要求"]

说明：
  - 配置保存在 ~/.infinite-canvas/canvas-cli.json；环境变量 CANVAS_CLI_BASE_URL / CANVAS_CLI_API_KEY 可临时覆盖。
  - 生图结果与审稿记录保存在 --out 目录（默认 ./canvas-cli-output）的 manifest.json，全部命令输出 JSON。
  - generate 带参考图时走图生图：openai 协议用 /v1/images/edits，gemini 协议用 inlineData。
  - auto-review 需要 config set --review-model 配置视觉审稿模型（OpenAI 兼容 /v1/chat/completions）。`

func main() {
	if len(os.Args) < 2 {
		fmt.Println(usageText)
		os.Exit(1)
	}
	switch os.Args[1] {
	case "config":
		cmdConfig(os.Args[2:])
	case "generate":
		cmdGenerate(os.Args[2:])
	case "list":
		cmdList(os.Args[2:])
	case "review":
		cmdReview(os.Args[2:])
	case "auto-review":
		cmdAutoReview(os.Args[2:])
	case "help", "-h", "--help":
		fmt.Println(usageText)
	default:
		failf("未知命令：%s（执行 canvas-cli help 查看用法）", os.Args[1])
	}
}

func cmdConfig(args []string) {
	if len(args) == 0 {
		failf("缺少子命令：config set / config show")
	}
	switch args[0] {
	case "show":
		cfg := loadConfig()
		emit(map[string]any{"ok": true, "configPath": configPath(), "config": maskedConfig(cfg)})
	case "set":
		cmdConfigSet(args[1:])
	default:
		failf("未知 config 子命令：%s", args[0])
	}
}

func cmdConfigSet(args []string) {
	fs := newFlagSet("config set")
	var protocol, baseURL, apiKey, imageModel, reviewModel, reviewBaseURL, reviewAPIKey, size, quality string
	timeout := fs.Int("timeout", 0, "请求超时秒数")
	fs.StringVar(&protocol, "protocol", "", "生图协议 openai|gemini")
	fs.StringVar(&baseURL, "base-url", "", "渠道地址")
	fs.StringVar(&apiKey, "api-key", "", "渠道 API Key")
	fs.StringVar(&imageModel, "image-model", "", "生图模型")
	fs.StringVar(&reviewModel, "review-model", "", "自动审稿模型")
	fs.StringVar(&reviewBaseURL, "review-base-url", "", "审稿接口地址（默认用 base-url）")
	fs.StringVar(&reviewAPIKey, "review-api-key", "", "审稿 API Key（默认用 api-key）")
	fs.StringVar(&size, "size", "", "默认尺寸 1:1 / 1024x1024 / auto")
	fs.StringVar(&quality, "quality", "", "默认质量 auto|low|medium|high")
	parseFlags(fs, args)

	if fs.NFlag() == 0 {
		failf("没有要修改的配置项")
	}
	cfg := loadConfig()
	if fs.Changed("protocol") {
		if protocol != "openai" && protocol != "gemini" {
			failf("protocol 只支持 openai 或 gemini")
		}
		cfg.Protocol = protocol
	}
	if fs.Changed("base-url") {
		if parsed, err := url.Parse(baseURL); err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			failf("base-url 格式错误")
		}
		cfg.BaseURL = strings.TrimRight(baseURL, "/")
	}
	if fs.Changed("api-key") {
		cfg.APIKey = strings.TrimSpace(apiKey)
	}
	if fs.Changed("image-model") {
		cfg.ImageModel = strings.TrimSpace(imageModel)
	}
	if fs.Changed("review-model") {
		cfg.ReviewModel = strings.TrimSpace(reviewModel)
	}
	if fs.Changed("review-base-url") {
		cfg.ReviewBaseURL = strings.TrimSpace(reviewBaseURL)
	}
	if fs.Changed("review-api-key") {
		cfg.ReviewAPIKey = strings.TrimSpace(reviewAPIKey)
	}
	if fs.Changed("size") {
		cfg.Size = strings.TrimSpace(size)
	}
	if fs.Changed("quality") {
		cfg.Quality = strings.TrimSpace(quality)
	}
	if fs.Changed("timeout") {
		if *timeout <= 0 {
			failf("timeout 必须大于 0")
		}
		cfg.TimeoutSeconds = *timeout
	}

	if err := os.MkdirAll(filepath.Dir(configPath()), 0o700); err != nil {
		failf("创建配置目录失败：%v", err)
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath(), append(data, '\n'), 0o600); err != nil {
		failf("写入配置失败：%v", err)
	}
	emit(map[string]any{"ok": true, "configPath": configPath(), "config": maskedConfig(cfg)})
}

func maskedConfig(cfg Config) Config {
	shown := cfg
	shown.APIKey = maskSecret(cfg.APIKey)
	shown.ReviewAPIKey = maskSecret(cfg.ReviewAPIKey)
	return shown
}

func maskSecret(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 8 {
		return "***"
	}
	return value[:4] + "***"
}
