package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ---------- manifest ----------

type ReviewEntry struct {
	Status     string `json:"status"` // approved | rejected
	Score      int    `json:"score,omitempty"`
	Note       string `json:"note,omitempty"`
	Reviewer   string `json:"reviewer"` // manual | auto
	ReviewedAt string `json:"reviewedAt"`
}

type ManifestImage struct {
	ID        string       `json:"id"`
	File      string       `json:"file"`
	Prompt    string       `json:"prompt"`
	Model     string       `json:"model"`
	Size      string       `json:"size,omitempty"`
	Quality   string       `json:"quality,omitempty"`
	Protocol  string       `json:"protocol"`
	CreatedAt string       `json:"createdAt"`
	Review    *ReviewEntry `json:"review"`
}

type Manifest struct {
	Images []ManifestImage `json:"images"`
}

func manifestPath(outDir string) string {
	return filepath.Join(outDir, "manifest.json")
}

func loadManifest(outDir string) Manifest {
	var manifest Manifest
	if data, err := os.ReadFile(manifestPath(outDir)); err == nil {
		_ = json.Unmarshal(data, &manifest)
	}
	return manifest
}

func saveManifest(outDir string, manifest Manifest) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		failf("创建输出目录失败：%v", err)
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		failf("序列化 manifest 失败：%v", err)
	}
	if err := os.WriteFile(manifestPath(outDir), append(data, '\n'), 0o644); err != nil {
		failf("写入 manifest 失败：%v", err)
	}
}

func newID() string {
	buffer := make([]byte, 4)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// ---------- generate ----------

type refImage struct {
	Name     string
	MimeType string
	Data     []byte
}

type generatedImage struct {
	Data     []byte
	MimeType string
}

func cmdGenerate(args []string) {
	fs := newFlagSet("generate")
	var prompt, outDir, size, quality, model, prefix string
	var count int
	var refs stringList
	fs.StringVar(&prompt, "prompt", "", "生图提示词")
	fs.StringVar(&outDir, "out", defaultOutDir, "输出目录")
	fs.IntVar(&count, "n", 1, "生成张数 1-15")
	fs.StringVar(&size, "size", "", "尺寸 1:1 / 1024x1024 / auto（默认用配置）")
	fs.StringVar(&quality, "quality", "", "质量 auto|low|medium|high（默认用配置）")
	fs.StringVar(&model, "model", "", "生图模型（默认用配置）")
	fs.StringVar(&prefix, "prefix", "", "输出文件名前缀")
	fs.Var(&refs, "ref", "参考图路径，可重复或逗号分隔，走图生图")
	parseFlags(fs, args)

	if strings.TrimSpace(prompt) == "" {
		failf("缺少 --prompt")
	}
	cfg := loadConfig()
	if cfg.APIKey == "" {
		failf("还没有配置 API Key：先执行 canvas-cli config set --base-url <渠道地址> --api-key <Key>")
	}
	if model == "" {
		model = cfg.ImageModel
	}
	if model == "" {
		failf("缺少模型：--model 或 canvas-cli config set --image-model")
	}
	protocol := cfg.Protocol
	if protocol == "" {
		protocol = "openai"
	}
	if protocol != "openai" && protocol != "gemini" {
		failf("protocol 只支持 openai 或 gemini，当前为 %s", protocol)
	}
	if size == "" {
		size = cfg.Size
	}
	if quality == "" {
		quality = cfg.Quality
	}
	count = clampCount(count)

	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	resolved := resolveRequestSize(quality, size)
	var images []generatedImage
	recordedSize := size
	if protocol == "openai" {
		images = generateOpenAI(client, cfg, model, prompt, resolved, quality, count, loadRefs(refs))
		if resolved != "" {
			recordedSize = resolved
		} else {
			recordedSize = "auto"
		}
	} else {
		images = generateGemini(client, cfg, model, prompt, size, resolved, quality, count, loadRefs(refs))
	}
	entries := saveGeneratedImages(outDir, prefix, images, manifestMeta{
		prompt: prompt, model: model, size: recordedSize, quality: quality, protocol: protocol,
	})
	emit(map[string]any{"ok": true, "dir": outDir, "images": entries})
}

type manifestMeta struct {
	prompt   string
	model    string
	size     string
	quality  string
	protocol string
}

func saveGeneratedImages(outDir, prefix string, images []generatedImage, meta manifestMeta) []ManifestImage {
	manifest := loadManifest(outDir)
	stamp := time.Now().Format("20060102-150405")
	now := time.Now().Format(time.RFC3339)
	if prefix = strings.TrimSpace(prefix); prefix != "" {
		prefix = strings.Trim(prefix, "-") + "-"
	}
	entries := make([]ManifestImage, 0, len(images))
	for i, img := range images {
		_, ext := sniffImage(img.Data, img.MimeType)
		path := uniquePath(outDir, fmt.Sprintf("%s%s-%d%s", prefix, stamp, i+1, ext))
		if err := os.WriteFile(path, img.Data, 0o644); err != nil {
			failf("写入图片失败：%v", err)
		}
		entry := ManifestImage{
			ID:        newID(),
			File:      filepath.Base(path),
			Prompt:    meta.prompt,
			Model:     meta.model,
			Size:      meta.size,
			Quality:   meta.quality,
			Protocol:  meta.protocol,
			CreatedAt: now,
		}
		manifest.Images = append(manifest.Images, entry)
		entries = append(entries, entry)
	}
	saveManifest(outDir, manifest)
	return entries
}

func uniquePath(dir, name string) string {
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err != nil {
		return path
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
		if _, err := os.Stat(candidate); err != nil {
			return candidate
		}
	}
}

type stringList []string

func (list *stringList) String() string {
	return strings.Join(*list, ",")
}

func (list *stringList) Set(value string) error {
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			*list = append(*list, item)
		}
	}
	return nil
}

func clampCount(count int) int {
	if count < 1 {
		return 1
	}
	if count > 15 {
		return 15
	}
	return count
}

func loadRefs(paths []string) []refImage {
	var refs []refImage
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			failf("读取参考图失败 %s：%v", path, err)
		}
		if len(data) > 25<<20 {
			failf("参考图过大：%s（上限 25MB）", path)
		}
		mimeType, _ := sniffImage(data, "")
		if mimeType == "" {
			mimeType = "image/png"
		}
		refs = append(refs, refImage{Name: filepath.Base(path), MimeType: mimeType, Data: data})
	}
	return refs
}

// ---------- OpenAI 兼容协议 ----------

func generateOpenAI(client *http.Client, cfg Config, model, prompt, size, quality string, count int, refs []refImage) []generatedImage {
	if len(refs) == 0 {
		body := map[string]any{"model": model, "prompt": prompt}
		if size != "" {
			body["size"] = size
		}
		if quality != "" && quality != "auto" {
			body["quality"] = quality
		}
		if count > 1 {
			body["n"] = count
		}
		data := doJSON(client, http.MethodPost, buildAPIURL(cfg.BaseURL, "/images/generations"), "Bearer "+cfg.APIKey, body)
		return imagesFromOpenAIResponse(client, data)
	}

	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	addFormField(writer, "model", model)
	addFormField(writer, "prompt", prompt)
	if size != "" {
		addFormField(writer, "size", size)
	}
	if quality != "" && quality != "auto" {
		addFormField(writer, "quality", quality)
	}
	if count > 1 {
		addFormField(writer, "n", strconv.Itoa(count))
	}
	for _, ref := range refs {
		addFormFile(writer, "image", ref.Name, ref.MimeType, ref.Data)
	}
	if err := writer.Close(); err != nil {
		failf("构造参考图请求失败：%v", err)
	}
	data := doRequest(client, func() (*http.Response, error) {
		request, err := http.NewRequest(http.MethodPost, buildAPIURL(cfg.BaseURL, "/images/edits"), &buffer)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		return client.Do(request)
	})
	return imagesFromOpenAIResponse(client, data)
}

type openAIImagesPayload struct {
	Data []struct {
		B64 string `json:"b64_json"`
		URL string `json:"url"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func imagesFromOpenAIResponse(client *http.Client, data []byte) []generatedImage {
	var payload openAIImagesPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		failf("生图响应解析失败：%s", truncateText(string(data), 300))
	}
	if payload.Error != nil && payload.Error.Message != "" {
		failf("生图失败：%s", payload.Error.Message)
	}
	var images []generatedImage
	for _, item := range payload.Data {
		switch {
		case item.B64 != "":
			decoded, err := base64.StdEncoding.DecodeString(item.B64)
			if err != nil {
				decoded, err = base64.RawStdEncoding.DecodeString(item.B64)
			}
			if err != nil {
				failf("图片 base64 解码失败：%v", err)
			}
			images = append(images, generatedImage{Data: decoded, MimeType: "image/png"})
		case item.URL != "":
			images = append(images, downloadImage(client, item.URL))
		}
	}
	if len(images) == 0 {
		failf("接口没有返回图片：%s", truncateText(string(data), 300))
	}
	return images
}

func downloadImage(client *http.Client, imageURL string) generatedImage {
	resp, err := client.Get(imageURL)
	if err != nil {
		failf("下载生成图片失败：%v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode >= 400 {
		failf("下载生成图片失败 %d：%s", resp.StatusCode, imageURL)
	}
	return generatedImage{Data: data, MimeType: resp.Header.Get("Content-Type")}
}

// ---------- Gemini 原生协议 ----------

func generateGemini(client *http.Client, cfg Config, model, prompt, size, resolved, quality string, count int, refs []refImage) []generatedImage {
	model = strings.TrimPrefix(strings.TrimSpace(model), "models/")
	endpoint := fmt.Sprintf("%s/v1beta/models/%s:generateContent", normalizeGeminiBaseURL(cfg.BaseURL), url.PathEscape(model))
	var images []generatedImage
	for i := 0; i < count; i++ {
		images = append(images, geminiOnce(client, cfg.APIKey, endpoint, model, prompt, size, resolved, quality, refs)...)
	}
	return images
}

func geminiOnce(client *http.Client, apiKey, endpoint, model, prompt, size, resolved, quality string, refs []refImage) []generatedImage {
	parts := []any{map[string]any{"text": prompt}}
	for _, ref := range refs {
		parts = append(parts, map[string]any{"inlineData": map[string]any{
			"mimeType": ref.MimeType,
			"data":     base64.StdEncoding.EncodeToString(ref.Data),
		}})
	}
	generationConfig := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
	imageConfig := map[string]any{}
	if aspect := normalizeGeminiRatio(size); aspect != "" {
		imageConfig["aspectRatio"] = aspect
	}
	if imageSize := geminiImageSize(strings.ToLower(strings.TrimSpace(quality)), strings.ToLower(size+" "+resolved)); imageSize != "" && !strings.Contains(strings.ToLower(model), "2.5") {
		imageConfig["imageSize"] = imageSize
	}
	if len(imageConfig) > 0 {
		generationConfig["imageConfig"] = imageConfig
	}
	body := map[string]any{
		"contents":         []any{map[string]any{"role": "user", "parts": parts}},
		"generationConfig": generationConfig,
	}
	data := doJSONWithHeaders(client, http.MethodPost, endpoint, map[string]string{"x-goog-api-key": apiKey}, body)

	var payload struct {
		Candidates []struct {
			FinishReason string `json:"finishReason"`
			Content      struct {
				Parts []struct {
					InlineData *struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		PromptFeedback *struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		failf("Gemini 响应解析失败：%s", truncateText(string(data), 300))
	}
	var images []generatedImage
	for _, candidate := range payload.Candidates {
		for _, part := range candidate.Content.Parts {
			if part.InlineData == nil || part.InlineData.Data == "" {
				continue
			}
			decoded, err := base64.StdEncoding.DecodeString(part.InlineData.Data)
			if err != nil {
				failf("Gemini 图片 base64 解码失败：%v", err)
			}
			mimeType := part.InlineData.MimeType
			if mimeType == "" {
				mimeType = "image/png"
			}
			images = append(images, generatedImage{Data: decoded, MimeType: mimeType})
		}
	}
	if len(images) == 0 {
		failf("Gemini 接口没有返回图片：%s", truncateText(geminiErrorMessage(data), 300))
	}
	return images
}

func geminiErrorMessage(data []byte) string {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		PromptFeedback *struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
		Candidates []struct {
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
	}
	_ = json.Unmarshal(data, &payload)
	if payload.Error != nil && payload.Error.Message != "" {
		return payload.Error.Message
	}
	if payload.PromptFeedback != nil && payload.PromptFeedback.BlockReason != "" {
		return "请求被安全策略拦截：" + payload.PromptFeedback.BlockReason
	}
	for _, candidate := range payload.Candidates {
		if candidate.FinishReason != "" {
			return "生成未返回图片（finishReason: " + candidate.FinishReason + "）"
		}
	}
	return "Gemini 接口没有返回图片"
}

// ---------- 请求与解析工具 ----------

func doJSON(client *http.Client, method, endpoint, authorization string, body any) []byte {
	return doJSONWithHeaders(client, method, endpoint, map[string]string{"Authorization": authorization}, body)
}

func doJSONWithHeaders(client *http.Client, method, endpoint string, headers map[string]string, body any) []byte {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			failf("请求序列化失败：%v", err)
		}
		reader = bytes.NewReader(encoded)
	}
	return doRequest(client, func() (*http.Response, error) {
		request, err := http.NewRequest(method, endpoint, reader)
		if err != nil {
			return nil, err
		}
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		return client.Do(request)
	})
}

func doRequest(client *http.Client, send func() (*http.Response, error)) []byte {
	resp, err := send()
	if err != nil {
		failf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode >= 400 {
		failf("上游接口返回 %d：%s", resp.StatusCode, truncateText(string(data), 500))
	}
	return data
}

func addFormField(writer *multipart.Writer, key, value string) {
	if err := writer.WriteField(key, value); err != nil {
		failf("构造表单失败：%v", err)
	}
}

func addFormFile(writer *multipart.Writer, field, filename, mimeType string, data []byte) {
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		failf("构造参考图字段失败：%v", err)
	}
	if _, err := part.Write(data); err != nil {
		failf("写入参考图失败：%v", err)
	}
}

// buildAPIURL 复刻前端 buildApiUrl 的拼接规则：baseUrl 以版本后缀结尾则直接拼，否则补 /v1。
// 额外放行 /v1beta/openai（Gemini 的 OpenAI 兼容层）。
func buildAPIURL(baseURL, path string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	lower := strings.ToLower(base)
	for _, suffix := range []string{"/v1", "/api/v3", "/api/plan/v3", "/api/paas/v4", "/v1beta/openai"} {
		if strings.HasSuffix(lower, suffix) {
			return base + path
		}
	}
	return base + "/v1" + path
}

func normalizeGeminiBaseURL(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return "https://generativelanguage.googleapis.com"
	}
	if len(base) >= 7 && strings.EqualFold(base[len(base)-7:], "/v1beta") {
		base = base[:len(base)-7]
	}
	return base
}

// ---------- 尺寸 / 质量 / 图片格式（口径与前端 image.ts 一致） ----------

var qualityBase = map[string]int{"low": 1024, "medium": 2048, "high": 2880, "standard": 1024, "hd": 2048}
var qualityAliases = map[string]string{"1k": "low", "2k": "medium", "4k": "high"}

func normalizeQuality(quality string) string {
	value := strings.ToLower(strings.TrimSpace(quality))
	if value == "" || value == "auto" {
		return "auto"
	}
	if alias, ok := qualityAliases[value]; ok {
		value = alias
	}
	if _, ok := qualityBase[value]; ok {
		return value
	}
	return "auto"
}

func resolveRequestSize(quality, size string) string {
	value := strings.TrimSpace(size)
	if value == "" || value == "auto" {
		return ""
	}
	if isPixelSize(value) {
		return value
	}
	base := normalizeQuality(quality)
	if _, ok := qualityBase[base]; !ok {
		base = "low"
	}
	return resolveSize(base, value)
}

func isPixelSize(value string) bool {
	parts := strings.SplitN(value, "x", 2)
	if len(parts) != 2 {
		return false
	}
	width, err1 := strconv.Atoi(parts[0])
	height, err2 := strconv.Atoi(parts[1])
	return err1 == nil && err2 == nil && width > 0 && height > 0
}

func resolveSize(baseQuality, ratio string) string {
	basePixels, ok := qualityBase[baseQuality]
	if !ok || ratio == "auto" || ratio == "" {
		return ""
	}
	parts := strings.Split(ratio, ":")
	if len(parts) != 2 {
		return ""
	}
	width, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || width <= 0 || height <= 0 {
		return ""
	}
	a := gcd(width, height)
	unit := int(math.Round(math.Sqrt(float64(basePixels*basePixels)/float64((width/a)*(height/a))))/16) * 16
	w, h := (width/a)*unit, (height/a)*unit
	return fmt.Sprintf("%dx%d", w, h)
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	return a
}

func normalizeGeminiRatio(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	exact := map[string]string{
		"1:1": "1:1", "2048x2048": "1:1", "3:2": "3:2", "2:3": "2:3", "4:3": "4:3", "3:4": "3:4",
		"16:9": "16:9", "2048x1152": "16:9", "3840x2160": "16:9", "9:16": "9:16", "1152x2048": "9:16",
		"2160x3840": "9:16", "21:9": "21:9", "3136x1344": "21:9", "6272x2688": "21:9",
	}
	if mapped, ok := exact[normalized]; ok {
		return mapped
	}
	if normalized == "auto" || normalized == "" {
		return ""
	}
	if isPixelSize(normalized) {
		parts := strings.SplitN(normalized, "x", 2)
		width, _ := strconv.Atoi(parts[0])
		height, _ := strconv.Atoi(parts[1])
		ratios := []struct {
			name  string
			value float64
		}{{"1:1", 1}, {"3:2", 1.5}, {"2:3", 2.0 / 3.0}, {"4:3", 4.0 / 3.0}, {"3:4", 3.0 / 4.0}, {"16:9", 16.0 / 9.0}, {"9:16", 9.0 / 16.0}, {"21:9", 21.0 / 9.0}}
		best := ratios[0]
		ratio := float64(width) / float64(height)
		for _, item := range ratios[1:] {
			if abs(item.value-ratio) < abs(best.value-ratio) {
				best = item
			}
		}
		return best.name
	}
	return "1:1"
}

func geminiImageSize(quality, preset string) string {
	switch quality {
	case "low":
		return "1K"
	case "medium":
		return "2K"
	case "high":
		return "4K"
	}
	switch {
	case strings.Contains(preset, "6272x2688") || strings.Contains(preset, "3840x2160") || strings.Contains(preset, "2160x3840"):
		return "4K"
	case strings.Contains(preset, "2048x") || strings.Contains(preset, "3136x1344"):
		return "2K"
	}
	return ""
}

func abs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

// sniffImage 按字节头识别图片类型，识别不出时回退声明 MIME（口径与前端 image-utils.ts 一致）。
func sniffImage(data []byte, declaredMime string) (string, string) {
	switch {
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg", ".jpg"
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}):
		return "image/png", ".png"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp", ".webp"
	case len(data) >= 6 && bytes.Equal(data[:6], []byte("GIF8")):
		return "image/gif", ".gif"
	}
	declaredMime = strings.ToLower(strings.TrimSpace(strings.Split(declaredMime, ";")[0]))
	if extensions, _ := mime.ExtensionsByType(declaredMime); len(extensions) > 0 {
		return declaredMime, extensions[0]
	}
	return "", ".png"
}

func truncateText(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}
