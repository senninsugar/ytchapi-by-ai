import express from "express";
import cors from "cors";
import { Agent as UndiciAgent } from "undici";

const app = express();
const PORT = 3012;

app.use(cors());

// ==========================================
// 定数・設定定義
// ==========================================
const YOUTUBE_CHANNEL_URL = "https://www.youtube.com/channel/";
const YOUTUBE_API_URL = "https://www.youtube.com/youtubei/v1/browse";
const INNERTUBE_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";

const REQUEST_HEADERS = {
  "accept": "*/*",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "ja,en;q=0.9",
  "cache-control": "no-cache",
  "origin": "https://www.youtube.com",
  "referer": "https://www.youtube.com/",
  "user-agent": "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
};

const undiciAgent = new UndiciAgent({
  connections: 16,
  keepAliveTimeout: 6000,
});

const CLIENT_CONTEXT = {
  client: {
    hl: "ja",
    gl: "JP",
    clientName: "WEB",
    clientVersion: "2.20240214.01.00",
    ua: REQUEST_HEADERS["user-agent"],
  },
};

// 画像をBase64に変換するユーティリティ
const fetchImageAsBase64 = async (url) => {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      dispatcher: undiciAgent,
      headers: {
        Referer: "https://www.youtube.com/",
        "User-Agent": REQUEST_HEADERS["user-agent"],
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const b = Buffer.from(buf);
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${b.toString("base64")}`;
  } catch (e) {
    console.warn("fetchImageAsBase64 failed", e?.message || e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const getTextFromRuns = (runs) => {
  return runs?.map((run) => run.text).join("") || null;
};

// ==========================================
// API ルーティング (チャンネル情報取得)
// ==========================================
app.get("/api/channel/:id", async (req, res) => {
  let channelId = req.params.id;
  try {
    channelId = decodeURIComponent(channelId);
  } catch (e) {}

  if (!channelId) {
    return res.status(400).json({ error: "Missing channel ID parameter" });
  }

  // UCから始まらないカスタムハンドルの場合は、スクレイピング経由で処理するか、エラーハンドリングを行います
  const targetUrl = channelId.startsWith("UC") 
    ? `${YOUTUBE_CHANNEL_URL}${channelId}` 
    : `https://www.youtube.com/${channelId}`;

  try {
    // 初回ロード: HTMLスクレイピングによるデータ抽出
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: REQUEST_HEADERS,
    });

    if (!response.ok) {
      return res.status(response.status).json({
        id: channelId,
        unavailable: true,
        reason: `Service unavailable (Status ${response.status})`,
      });
    }

    const html = await response.text();
    const regex = /var ytInitialData\s*=\s*({.*?});/s;
    const match = html.match(regex);

    if (!match || !match[1]) {
      return res.status(500).json({
        id: channelId,
        unavailable: true,
        reason: "Failed to extract channel data",
      });
    }

    const rawData = JSON.parse(match[1]);
    
    // チャンネルヘッダーの解析構造
    const header = rawData.header?.pageHeaderRenderer || rawData.header?.c4TabbedHeaderRenderer;
    const metadata = rawData.metadata?.channelMetadataRenderer;

    if (!header) {
      return res.status(404).json({
        id: channelId,
        unavailable: true,
        reason: "Channel components not found",
      });
    }

    // --- 新しいUI構造 (pageHeaderRenderer) の場合のパース ---
    let channelName = "";
    let avatarUrl = "";
    let bannerUrl = "";
    let subscriberCount = "";
    let videoCount = "";
    let handleText = "";
    let description = metadata?.description || "";

    if (rawData.header?.pageHeaderRenderer) {
      const pageHeader = rawData.header.pageHeaderRenderer;
      const content = pageHeader.content?.pageHeaderViewModel;
      
      channelName = content?.title?.dynamicTextViewModel?.text?.content || "";
      
      // アバター・バナー
      avatarUrl = content?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url || "";
      bannerUrl = pageHeader.banner?.bannerViewModel?.image?.sources?.slice(-1)[0]?.url || ""; // 最大解像度を取得
      
      // メタデータ行の解析（登録者数、動画数など）
      const metadataRows = content?.metadata?.contentMetadataViewModel?.metadataRows || [];
      if (metadataRows.length > 0) {
        const parts = metadataRows[0].metadataParts || [];
        handleText = parts[0]?.text?.content || "";
        subscriberCount = parts[1]?.text?.content || "";
        videoCount = parts[2]?.text?.content || "";
      }
    } else if (rawData.header?.c4TabbedHeaderRenderer) {
      // --- 従来のUI構造 (c4TabbedHeaderRenderer) の場合のパース ---
      const c4Header = rawData.header.c4TabbedHeaderRenderer;
      channelName = c4Header.title || "";
      avatarUrl = c4Header.avatar?.thumbnails?.[0]?.url || "";
      bannerUrl = c4Header.banner?.thumbnails?.slice(-1)[0]?.url || "";
      subscriberCount = c4Header.subscriberCountText?.simpleText || "";
      handleText = c4Header.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
    }

    // 固定値フォールバックや補完
    if (!channelName && metadata) channelName = metadata.title || "";
    if (!avatarUrl && metadata) avatarUrl = metadata.avatar?.thumbnails?.[0]?.url || "";

    // 画像の Base64 変換処理
    const avatarB64 = avatarUrl ? (await fetchImageAsBase64(avatarUrl)) || avatarUrl : null;
    const bannerB64 = bannerUrl ? (await fetchImageAsBase64(bannerUrl)) || bannerUrl : null;

    // ---------------------------------------------------------
    // レスポンスJSONの構築
    // ---------------------------------------------------------
    res.json({
      id: metadata?.externalId || channelId,
      channelName: channelName,
      handle: handleText,
      subscribers: subscriberCount,
      videoCount: videoCount,
      avatar: avatarB64,
      banner: bannerB64,
      description: description,
      keywords: metadata?.keywords || "",
      vanityChannelUrl: metadata?.vanityChannelUrl || "",
      isVerified: !!header?.badges?.find(b => b.metadataBadgeRenderer?.style === "BADGE_STYLE_VERIFIED"),
      extended_data: {
        rssUrl: metadata?.rssUrl || "",
        channelUrl: metadata?.channelUrl || "",
      },
      trackingParams: rawData.trackingParams || null
    });

  } catch (parseError) {
    console.error(`[JSON Parse Error] ID: ${channelId}`, parseError);
    res.status(500).json({
      error: "Failed to parse internal channel data",
      detail: parseError.message,
    });
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Channel API Server running at http://localhost:${PORT}`);
});
