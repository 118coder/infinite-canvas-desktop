package service

import (
	"log"
	"runtime/debug"
	"time"
)

// guardPanic 在后台 goroutine 中运行 fn：未捕获的 panic 只记日志，不允许击穿进程。
// gin.Default() 只保护 HTTP 路径，常驻调度器与轮询 goroutine 必须自行 recover，
// 否则上游返回畸形数据时一次 panic 就会杀死整个进程（桌面版表现为应用闪退）。
func guardPanic(where string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("background task panic recovered where=%s err=%v\n%s", where, r, debug.Stack())
		}
	}()
	fn()
}

// guardPanicLoop 运行 fn，返回后（只会因 panic）稍等片刻再重启，避免常驻轮询永久停摆或刷爆日志。
func guardPanicLoop(where string, fn func()) {
	go func() {
		for {
			guardPanic(where, fn)
			log.Printf("background task exited unexpectedly, restarting where=%s", where)
			time.Sleep(time.Second)
		}
	}()
}
