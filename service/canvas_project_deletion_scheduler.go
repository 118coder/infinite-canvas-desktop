package service

import (
	"log"
	"os"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/tigerowo/infinite-canvas/repository"
)

const canvasProjectCleanupCron = "0 3 * * *"

var (
	canvasProjectCron     *cron.Cron
	canvasProjectCronOnce sync.Once
)

func StartCanvasProjectCleanupScheduler() {
	canvasProjectCronOnce.Do(func() {
		// cron 作业默认不 recover，panic 会杀死整个进程，这里统一挂上恢复器。
		canvasProjectCron = cron.New(cron.WithChain(cron.Recover(cron.PrintfLogger(log.New(os.Stderr, "[cron] ", log.LstdFlags)))))
		if _, err := canvasProjectCron.AddFunc(
			canvasProjectCleanupCron,
			cleanupExpiredCanvasProjects,
		); err != nil {
			log.Printf(
				"add canvas project cleanup cron failed err=%v",
				err,
			)
			return
		}
		canvasProjectCron.Start()
	})

	cleanupExpiredCanvasProjects()
}

func cleanupExpiredCanvasProjects() {
	if err := repository.CleanupDeletedCanvasProjects(
		time.Now().UTC().
			Add(-7 * 24 * time.Hour).
			Format(time.RFC3339Nano),
	); err != nil {
		log.Printf(
			"cleanup canvas projects failed err=%v",
			err,
		)
	}
}
