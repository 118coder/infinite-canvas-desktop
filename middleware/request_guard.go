package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// bodyLimitRules 按路径前缀放宽请求体上限：上传/多媒体类大文件路由。
// 其余接口统一 10MB——此前绝大多数接口没有 body 上限，
// 未鉴权的登录/注册接口也能被超大 JSON 打爆内存。
var bodyLimitRules = []struct {
	prefix string
	limit  int64
}{
	{"/api/bridge/comfy/result", 129 << 20},
	{"/api/anonymous/files", 129 << 20},
	{"/api/v1/files", 129 << 20},
	{"/api/v1/videos", 129 << 20},
	{"/api/v1/canvas/image-tasks", 129 << 20},
	{"/api/v1/canvas/audio-tasks", 129 << 20},
	{"/api/v1/canvas/projects", 32 << 20},
	{"/api/v1/user-data/", 32 << 20},
	{"/api/v1/generation-logs/", 32 << 20},
}

const defaultBodyLimit = 10 << 20

// BodyLimit 给所有请求套上请求体大小上限。
func BodyLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		var limit int64 = defaultBodyLimit
		path := c.Request.URL.Path
		for _, rule := range bodyLimitRules {
			if len(path) >= len(rule.prefix) && path[:len(rule.prefix)] == rule.prefix {
				limit = rule.limit
				break
			}
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

type ipRateWindow struct {
	count    int
	windowAt time.Time
}

type ipRateLimiter struct {
	mu      sync.Mutex
	entries map[string]*ipRateWindow
	window  time.Duration
	max     int
}

func (l *ipRateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry, ok := l.entries[key]
	if !ok || now.Sub(entry.windowAt) >= l.window {
		// 惰性清理过期窗口，避免 map 无限增长。
		if len(l.entries) > 10000 {
			for k, v := range l.entries {
				if now.Sub(v.windowAt) >= l.window {
					delete(l.entries, k)
				}
			}
		}
		l.entries[key] = &ipRateWindow{count: 1, windowAt: now}
		return true
	}
	entry.count++
	return entry.count <= l.max
}

// RateLimit 按客户端 IP 做固定窗口限流，用于保护少量开放接口（如代理图片）。
func RateLimit(max int, window time.Duration) gin.HandlerFunc {
	limiter := &ipRateLimiter{entries: map[string]*ipRateWindow{}, window: window, max: max}
	return func(c *gin.Context) {
		if !limiter.allow(c.ClientIP()) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": 1, "data": nil, "msg": "请求过于频繁，请稍后再试"})
			return
		}
		c.Next()
	}
}
