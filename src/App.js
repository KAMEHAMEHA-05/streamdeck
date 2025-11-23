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
  const [files, setFiles] = useState([]);
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

  async function loadFiles(folder) {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: folder + "/",
      })
    );

    const list = (result.Contents || [])
      .map((o) => o.Key)
      .filter((k) =>
        k.match(/\.(mp4|mkv|mov|avi|webm|mp3|m4v)$/i)
      );

    setFiles(list);
  }

  async function play(key) {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
      { expiresIn: 3600 }
    );

    setVideoUrl(url);
  }

  return (
    <div
      style={{
        background: "#0d0d0d",
        color: "#e6e6e6",
        minHeight: "100vh",
        padding: "40px",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <h1 style={{ fontWeight: 500, marginBottom: 30 }}>Video Library</h1>

      {videoUrl && (
        <video
          src={videoUrl}
          controls
          style={{
            width: "100%",
            marginBottom: 30,
            borderRadius: 8,
            background: "#000",
          }}
        />
      )}

      <div style={{ display: "flex", gap: 60 }}>
        <div style={{ width: "30%" }}>
          <h2 style={{ marginBottom: 15 }}>Folders</h2>
          <div style={{ opacity: 0.8, fontSize: 14 }}>Click to open</div>

          {folders.map((f) => (
            <div
              key={f}
              onClick={() => loadFiles(f)}
              style={{
                padding: "12px 0",
                borderBottom: "1px solid #222",
                cursor: "pointer",
                transition: "0.2s",
              }}
            >
              {f}
            </div>
          ))}
        </div>

        <div style={{ width: "70%" }}>
          <h2 style={{ marginBottom: 15 }}>Files</h2>

          {files.map((file) => (
            <div
              key={file}
              onClick={() => play(file)}
              style={{
                padding: "10px 0",
                borderBottom: "1px solid #222",
                cursor: "pointer",
              }}
            >
              {file.split("/").slice(-1)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
