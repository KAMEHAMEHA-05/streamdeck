import { useState, useEffect, useRef } from "react";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";

const s3 = new S3Client({
  region: process.env.REACT_APP_AWS_REGION,
  credentials: {
    accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY,
  },
});

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

const BUCKET = process.env.REACT_APP_AWS_BUCKET;

export default function App() {
  const [folders, setFolders] = useState([]);
  const [videoUrl, setVideoUrl] = useState("");
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [partyCode, setPartyCode] = useState("");
  const [isHost, setIsHost] = useState(false);
  const videoRef = useRef(null);
  const ignoreNextUpdate = useRef(false);
  const channelRef = useRef(null);

  useEffect(() => {
    loadFolders();
    
    // Check if there's a party code in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("party");
    if (code) {
      setPartyCode(code);
      joinParty(code);
    }
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
      
      // If in a party, update the party state
      if (partyCode) {
        await updatePartyState({
          video_url: url,
          folder: folder,
          playback_time: 0,
          is_playing: false,
        });
      }
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
      
      if (partyCode) {
        await updatePartyState({ subtitle_url: url });
      }
    } else {
      setSubtitleUrl("");
    }
  }

  function generatePartyCode() {
    return Math.floor(10000 + Math.random() * 90000).toString();
  }

  async function createParty() {
    const code = generatePartyCode();
    
    // Create party in Supabase
    await supabase.from("parties").insert({
      code: code,
      video_url: videoUrl || "",
      subtitle_url: subtitleUrl || "",
      playback_time: 0,
      is_playing: false,
      folder: "",
    });

    setPartyCode(code);
    setIsHost(true);
    
    // Update URL
    const newUrl = `${window.location.origin}${window.location.pathname}?party=${code}`;
    window.history.pushState({}, "", newUrl);
    
    // Join the party
    joinParty(code);
  }

  async function joinParty(code) {
    // Subscribe to party updates
    const channel = supabase
      .channel(`party-${code}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "parties",
          filter: `code=eq.${code}`,
        },
        (payload) => {
          if (ignoreNextUpdate.current) {
            ignoreNextUpdate.current = false;
            return;
          }
          
          const state = payload.new;
          
          // Update video URL if changed
          if (state.video_url && state.video_url !== videoUrl) {
            setVideoUrl(state.video_url);
          }
          
          if (state.subtitle_url !== undefined) {
            setSubtitleUrl(state.subtitle_url);
          }
          
          // Sync video playback
          if (videoRef.current) {
            const timeDiff = Math.abs(videoRef.current.currentTime - state.playback_time);
            
            // Only seek if difference is significant (more than 1 second)
            if (timeDiff > 1) {
              videoRef.current.currentTime = state.playback_time;
            }
            
            if (state.is_playing && videoRef.current.paused) {
              videoRef.current.play();
            } else if (!state.is_playing && !videoRef.current.paused) {
              videoRef.current.pause();
            }
          }
        }
      )
      .subscribe();

    channelRef.current = channel;

    // Load initial party state
    const { data } = await supabase
      .from("parties")
      .select("*")
      .eq("code", code)
      .single();

    if (data) {
      if (data.video_url) setVideoUrl(data.video_url);
      if (data.subtitle_url) setSubtitleUrl(data.subtitle_url);
      
      if (videoRef.current) {
        videoRef.current.currentTime = data.playback_time;
        if (data.is_playing) {
          videoRef.current.play();
        }
      }
    }
  }

  async function updatePartyState(updates) {
    if (!partyCode) return;
    
    ignoreNextUpdate.current = true;
    
    await supabase
      .from("parties")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("code", partyCode);
  }

  // Video event handlers for syncing
  const handlePlay = () => {
    if (partyCode) {
      updatePartyState({
        is_playing: true,
        playback_time: videoRef.current?.currentTime || 0,
      });
    }
  };

  const handlePause = () => {
    if (partyCode) {
      updatePartyState({
        is_playing: false,
        playback_time: videoRef.current?.currentTime || 0,
      });
    }
  };

  const handleSeeked = () => {
    if (partyCode) {
      updatePartyState({
        playback_time: videoRef.current?.currentTime || 0,
      });
    }
  };

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 40 }}>
          <h1 style={{ fontWeight: 600, margin: 0, color: "#ffd700", fontSize: 36 }}>
            Ishaan's StreamDeck
          </h1>
          
          {!partyCode ? (
            <button
              onClick={createParty}
              style={{
                background: "linear-gradient(135deg, #ffa600ff, #efad07ff)",
                color: "#000",
                border: "none",
                borderRadius: 12,
                padding: "12px 24px",
                cursor: "pointer",
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 550,
                fontSize: 16,
                transition: "all 0.3s ease",
                //boxShadow: "0 4px 15px rgba(255, 215, 0, 0.3)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-2px)";
                e.currentTarget.style.boxShadow = "0 6px 20px rgba(255, 215, 0, 0.4)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 4px 15px rgba(255, 215, 0, 0.3)";
              }}
            >
              Create Party
            </button>
          ) : (
            <div style={{
              background: "rgba(255, 215, 0, 0.1)",
              border: "2px solid #ffae00ff",
              borderRadius: 12,
              padding: "12px 24px",
              fontFamily: "'Montserrat', sans-serif",
              fontWeight: 700,
              fontSize: 16,
              color: "#eda008ff",
            }}>
              Party Code: {partyCode}
            </div>
          )}
        </div>

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
              onPlay={handlePlay}
              onPause={handlePause}
              onSeeked={handleSeeked}
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