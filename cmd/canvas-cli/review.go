package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ---------- list ----------

func cmdList(args []string) {
	fs := newFlagSet("list")
	var outDir, status string
	fs.StringVar(&outDir, "out", defaultOutDir, "输出目录")
	fs.StringVar(&status, "status", "", "筛选 pending|approved|rejected，留空显示全部")
	parseFlags(fs, args)

	manifest := loadManifest(outDir)
	images := filterManifest(manifest, status)
	emit(map[string]any{"ok": true, "dir": outDir, "count": len(images), "images": images})
}

func filterManifest(manifest Manifest, status string) []ManifestImage {
	if status == "" {
		return manifest.Images
	}
	var images []ManifestImage
	for _, entry := range manifest.Images {
		switch status {
		case "pending":
			if entry.Review == nil {
				images = append(images, entry)
			}
		case "approved", "rejected":
			if entry.Review != nil && entry.Review.Status == status {
				images = append(images, entry)
			}
		default:
			failf("--status 只支持 pending / approved / rejected")
		}
	}
	return images
}

// ---------- review ----------

func cmdReview(args []string) {
	fs := newFlagSet("review")
	var file, status, note, outDir string
	var score int
	fs.StringVar(&file, "file", "", "图片文件名（manifest 中的 file 字段）")
	fs.StringVar(&status, "status", "", "approved | rejected")
	fs.IntVar(&score, "score", 0, "评分 1-10，可省略")
	fs.StringVar(&note, "note", "", "审稿意见")
	fs.StringVar(&outDir, "out", defaultOutDir, "输出目录")
	parseFlags(fs, args)

	if file == "" {
		failf("缺少 --file")
	}
	if status != "approved" && status != "rejected" {
		failf("--status 只支持 approved 或 rejected")
	}
	if score < 0 || score > 10 {
		failf("--score 取值 1-10")
	}

	manifest := loadManifest(outDir)
	entry := findManifestImage(manifest, file)
	if entry == nil {
		failf("manifest 中找不到该文件：%s（用 canvas-cli list --out %s 查看）", file, outDir)
	}
	entry.Review = &ReviewEntry{
		Status:     status,
		Score:      score,
		Note:       note,
		Reviewer:   "manual",
		ReviewedAt: time.Now().Format(time.RFC3339),
	}
	saveManifest(outDir, manifest)
	emit(map[string]any{"ok": true, "image": entry})
}

func findManifestImage(manifest Manifest, file string) *ManifestImage {
	base := filepath.Base(file)
	for i := range manifest.Images {
		if manifest.Images[i].File == base || manifest.Images[i].File == file {
			return &manifest.Images[i]
		}
	}
	return nil
}

// ---------- auto-review ----------

const defaultReviewPrompt = `你是严格的图片审稿员。请审查这张 AI 生成的图片，只输出一个 JSON 对象，不要输出任何其他文字：
{"verdict":"approved 或 rejected","score":1到10的整数,"note":"中文审稿意见，说明优点与问题","suggestion":"打回时的改进建议，通过则为空字符串"}
审稿标准：主体与细节是否符合提示词、构图与美感、是否有明显畸形或伪影；轻微瑕疵不构成打回。`

func cmdAutoReview(args []string) {
	fs := newFlagSet("auto-review")
	var outDir, extra string
	var minScore, limit int
	fs.StringVar(&outDir, "out", defaultOutDir, "输出目录")
	fs.IntVar(&minScore, "min-score", 0, "评分达到该值才通过；0 表示以模型 verdict 为准")
	fs.IntVar(&limit, "limit", 0, "本轮最多审稿张数；0 表示全部 pending")
	fs.StringVar(&extra, "extra", "", "附加审稿要求，追加到审稿指令后")
	parseFlags(fs, args)

	cfg := loadConfig()
	if cfg.ReviewModel == "" {
		failf("未配置审稿模型：先执行 canvas-cli config set --review-model <视觉模型名>")
	}
	apiKey := cfg.ReviewAPIKey
	if apiKey == "" {
		apiKey = cfg.APIKey
	}
	if apiKey == "" {
		failf("还没有配置 API Key：先执行 canvas-cli config set --api-key <Key>")
	}
	reviewBase := cfg.ReviewBaseURL
	if reviewBase == "" {
		reviewBase = cfg.BaseURL
	}
	endpoint := buildAPIURL(reviewBase, "/chat/completions")
	if cfg.ReviewBaseURL == "" && strings.EqualFold(cfg.Protocol, "gemini") {
		fmt.Fprintln(os.Stderr, "提示：gemini 生图协议的 base-url 未必兼容 OpenAI /chat/completions，可执行 config set --review-base-url 指定审稿接口地址")
	}

	manifest := loadManifest(outDir)
	pending := filterManifest(manifest, "pending")
	if limit > 0 && len(pending) > limit {
		pending = pending[:limit]
	}
	if len(pending) == 0 {
		emit(map[string]any{"ok": true, "reviewed": 0, "approved": 0, "rejected": 0, "results": []any{}})
		return
	}

	prompt := defaultReviewPrompt
	if extra = strings.TrimSpace(extra); extra != "" {
		prompt += "\n附加要求：" + extra
	}

	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	type autoResult struct {
		File   string `json:"file"`
		Status string `json:"status,omitempty"`
		Score  int    `json:"score,omitempty"`
		Note   string `json:"note,omitempty"`
		Error  string `json:"error,omitempty"`
	}
	var results []autoResult
	approved, rejected := 0, 0
	for _, pendingEntry := range pending {
		result := autoResult{File: pendingEntry.File}
		verdict, reviewErr := reviewOneImage(client, cfg, apiKey, endpoint, prompt, filepath.Join(outDir, pendingEntry.File))
		if reviewErr != "" {
			result.Error = reviewErr
		} else {
			entry := findManifestImage(manifest, pendingEntry.File)
			if entry == nil {
				result.Error = "manifest 中找不到该文件：" + pendingEntry.File
			} else {
				status := "rejected"
				if minScore > 0 {
					if verdict.score >= minScore {
						status = "approved"
					}
				} else if verdict.verdict == "approved" {
					status = "approved"
				}
				note := strings.TrimSpace(verdict.note)
				if verdict.suggestion != "" {
					note = strings.TrimSpace(note + "\n建议：" + verdict.suggestion)
				}
				entry.Review = &ReviewEntry{
					Status:     status,
					Score:      verdict.score,
					Note:       note,
					Reviewer:   "auto",
					ReviewedAt: time.Now().Format(time.RFC3339),
				}
				result.Status, result.Score, result.Note = status, verdict.score, note
				if status == "approved" {
					approved++
				} else {
					rejected++
				}
			}
		}
		results = append(results, result)
		saveManifest(outDir, manifest)
	}
	emit(map[string]any{"ok": true, "reviewed": len(results), "approved": approved, "rejected": rejected, "results": results})
}

type reviewVerdict struct {
	verdict    string
	score      int
	note       string
	suggestion string
}

func reviewOneImage(client *http.Client, cfg Config, apiKey, endpoint, prompt, imagePath string) (*reviewVerdict, string) {
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, fmt.Sprintf("读取图片失败：%v", err)
	}
	mimeType, _ := sniffImage(data, "")
	if mimeType == "" {
		mimeType = "image/png"
	}
	dataURL := "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
	body := map[string]any{
		"model": cfg.ReviewModel,
		"messages": []any{map[string]any{
			"role": "user",
			"content": []any{
				map[string]any{"type": "text", "text": prompt},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": dataURL}},
			},
		}},
	}
	requestData := doJSON(client, http.MethodPost, endpoint, "Bearer "+apiKey, body)

	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(requestData, &payload); err != nil {
		return nil, "审稿响应解析失败：" + truncateText(string(requestData), 300)
	}
	if payload.Error != nil && payload.Error.Message != "" {
		return nil, "审稿失败：" + payload.Error.Message
	}
	if len(payload.Choices) == 0 {
		return nil, "审稿接口没有返回结果"
	}
	verdict, err := parseReviewReply(payload.Choices[0].Message.Content)
	if err != nil {
		return nil, err.Error()
	}
	return verdict, ""
}

func parseReviewReply(text string) (*reviewVerdict, error) {
	cleaned := strings.ReplaceAll(text, "```", "")
	start := strings.Index(cleaned, "{")
	end := strings.LastIndex(cleaned, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("审稿回复中没有 JSON：%s", truncateText(text, 200))
	}
	var parsed struct {
		Verdict    string `json:"verdict"`
		Score      int    `json:"score"`
		Note       string `json:"note"`
		Suggestion string `json:"suggestion"`
	}
	if err := json.Unmarshal([]byte(cleaned[start:end+1]), &parsed); err != nil {
		return nil, fmt.Errorf("审稿 JSON 解析失败：%v", err)
	}
	return &reviewVerdict{
		verdict:    strings.ToLower(strings.TrimSpace(parsed.Verdict)),
		score:      parsed.Score,
		note:       parsed.Note,
		suggestion: parsed.Suggestion,
	}, nil
}
