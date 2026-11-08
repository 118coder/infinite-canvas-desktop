//go:build !windows

// 桌面壳只在 Windows 上构建（WebView2）。本文件让 `go test ./...`、`go vet ./...`
// 在 Linux/macOS 上也能编译通过，避免 CI 因平台专属依赖（go-webview2）整包失败。
package main

func main() {}
