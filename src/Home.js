import { useState, useEffect, useRef } from "react";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.REACT_APP_AWS_REGION,
  credentials: {
    accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.REACT_APP_AWS_BUCKET;

export default function App() {
  const [folders, setFolders] = useState([]);
  const [videoUrl, setVideoUrl] = useState("");
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [showSubtitles, setShowSubtitles] = useState(true);
  const videoRef = useRef(null);

  useEffect(() => {
    loadFolders();
  }, []);

  useEffect(() => {
    if (videoRef.current && videoRef.current.textTracks.length > 0) {
      videoRef.current.textTracks[0].mode = showSubtitles ? "showing" : "hidden";
    }
  }, [showSubtitles, subtitleUrl]);

  async function loadFolders() {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Delimiter: "/",
      })
    );

    const names = (result.CommonPrefixes || []).map((p) =>
      p.Prefix.replace("/", "")
    );

    setFolders(names);
  }

  async function loadVideo(folder) {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: folder + "/",
      })
    );

    const files = (result.Contents || []).map((o) => o.Key);
    
    const videoFile = files.find((k) =>
      k.match(/\.(mp4|mkv|mov|avi|webm|mp3|m4v)$/i)
    );

    const srtFile = files.find((k) => k.match(/\.vtt$/i));

    if (videoFile) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: videoFile,
        }),
        { expiresIn: 3600 }
      );

      setVideoUrl(url);
    }

    if (srtFile) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: srtFile,
        }),
        { expiresIn: 3600 }
      );

      setSubtitleUrl(url);
    } else {
      setSubtitleUrl("");
    }
  }

  return (
    <>
      <style>
        {`@import url('https://fonts.googleapis.com/css2?family=Merriweather:ital,opsz,wght@0,18..144,300..900;1,18..144,300..900&family=Montserrat:ital,wght@0,100..900;1,100..900&display=swap');`}
      </style>
      <div
        style={{
          background: `
            linear-gradient(to right, #1a1a1a 1px, transparent 1px),
            linear-gradient(to bottom, #1a1a1a 1px, transparent 1px),
            #0a0a0a
          `,
          backgroundSize: "60px 60px",
          color: "#e6e6e6",
          minHeight: "100vh",
          padding: "40px",
          fontFamily: "'Montserrat', sans-serif",
        }}
      >
        <h1 style={{ fontWeight: 600, marginBottom: 40, color: "#ffd700", fontSize: 36 }}>
          Ishaan's StreamDeck
        </h1>

        {videoUrl && (
          <div style={{
            marginBottom: 40,
            background: "rgba(255, 255, 255, 0.03)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: 16,
            padding: 16,
            position: "relative",
          }}>
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              crossOrigin="anonymous"
              style={{
                width: "100%",
                borderRadius: 12,
                background: "#000",
                display: "block",
              }}
            >
              {subtitleUrl && (
                <track
                    key={subtitleUrl}
                    kind="subtitles"
                    src={subtitleUrl}
                    srcLang="en"
                    label="English"
                    default
                    />
              )}
            </video>
            
            {subtitleUrl && (
              <button
                onClick={() => setShowSubtitles(!showSubtitles)}
                style={{
                  position: "absolute",
                  top: 28,
                  right: 28,
                  background: showSubtitles ? "rgba(255, 215, 0, 0.9)" : "rgba(0, 0, 0, 0.7)",
                  color: showSubtitles ? "#000" : "#fff",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: 8,
                  padding: "10px 16px",
                  cursor: "pointer",
                  fontFamily: "'Montserrat', sans-serif",
                  fontWeight: 600,
                  fontSize: 14,
                  transition: "all 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "scale(1.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                {showSubtitles ? "CC ON" : "CC OFF"}
              </button>
            )}
          </div>
        )}

        <div>
          <h2 style={{ marginBottom: 15, fontWeight: 500 }}>Streams Available</h2>

          <div style={{
            background: "rgba(255, 255, 255, 0.03)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: 12,
            padding: 20,
          }}>
            {folders.map((f) => (
              <div
                key={f}
                onClick={() => loadVideo(f)}
                style={{
                  padding: "16px 18px",
                  marginBottom: 8,
                  background: "rgba(255, 255, 255, 0.02)",
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  fontWeight: 500,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255, 215, 0, 0.08)";
                  e.currentTarget.style.borderColor = "rgba(255, 215, 0, 0.2)";
                  e.currentTarget.style.transform = "translateX(4px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(255, 255, 255, 0.02)";
                  e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.05)";
                  e.currentTarget.style.transform = "translateX(0)";
                }}
              >
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}