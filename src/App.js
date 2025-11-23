import { useState, useEffect } from "react";
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

  useEffect(() => {
    loadFolders();
  }, []);

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

    const videoFile = (result.Contents || [])
      .map((o) => o.Key)
      .find((k) =>
        k.match(/\.(mp4|mkv|mov|avi|webm|mp3|m4v)$/i)
      );

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
          }}>
            <video
              src={videoUrl}
              controls
              style={{
                width: "100%",
                borderRadius: 12,
                background: "#000",
                display: "block",
              }}
            />
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