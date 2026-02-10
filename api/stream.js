/* eslint-disable no-console */
const ytdl = require("@distube/ytdl-core");

/**
 * GET /api/stream?url=<youtube_url>
 * - Extracts highest quality audio-only stream
 * - Pipes audio stream to client
 * - Adds permissive CORS headers for PWA
 */
module.exports = async (req, res) => {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const { url } = req.query || {};
    if (!url || typeof url !== "string") {
      res.statusCode = 400;
      return res.end("Missing ?url= parameter");
    }

    if (!ytdl.validateURL(url)) {
      res.statusCode = 400;
      return res.end("Invalid YouTube URL");
    }

    const info = await ytdl.getInfo(url);
    const formats = ytdl.filterFormats(info.formats, "audioonly");

    if (!formats || formats.length === 0) {
      res.statusCode = 500;
      return res.end("No audio-only formats found");
    }

    // Prefer highest bitrate audio-only format
    formats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const chosen = formats[0];

    res.statusCode = 200;
    // Requirement: audio/mpeg (best-effort). Actual codec may be webm/opus from YouTube.
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    const stream = ytdl.downloadFromInfo(info, {
      format: chosen,
      highWaterMark: 1 << 25
    });

    stream.on("error", (err) => {
      console.error("ytdl stream error:", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end("Stream error");
    });

    stream.pipe(res);
  } catch (err) {
    console.error("stream handler error:", err);
    res.statusCode = 500;
    res.end("Server error");
  }
};
