import React, { useRef, useState, useEffect } from 'react';
import { X, Camera, SwitchCamera, AlertCircle } from 'lucide-react';

interface CameraModalProps {
  onCapture: (blob: Blob) => void;
  onClose: () => void;
  onFallbackToNativeInput: () => void;
}

export const CameraModal: React.FC<CameraModalProps> = ({
  onCapture,
  onClose,
  onFallbackToNativeInput,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let currentStream: MediaStream | null = null;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera API not available in this browser');
        }
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        currentStream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Could not start camera');
      }
    }

    startCamera();

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [facingMode]);

  const handleSnap = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Trigger flash animation
    setFlash(true);
    setTimeout(() => setFlash(false), 200);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          onCapture(blob);
          onClose();
        }
      },
      'image/jpeg',
      0.95,
    );
  };

  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: '#000000',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem',
          zIndex: 10,
        }}
      >
        <button className="btn-icon" onClick={onClose} aria-label="Close viewfinder">
          <X size={20} />
        </button>

        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f8fafc' }}>Capture Photo</span>

        <button
          className="btn-icon"
          onClick={toggleFacingMode}
          title="Switch front/back camera"
          aria-label="Switch camera"
        >
          <SwitchCamera size={20} />
        </button>
      </div>

      {/* Viewfinder Center */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {error ? (
          <div
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              maxWidth: '320px',
            }}
          >
            <AlertCircle size={36} color="var(--danger-red)" style={{ margin: '0 auto 1rem' }} />
            <p style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>{error}</p>
            <button
              className="btn-primary"
              onClick={() => {
                onClose();
                onFallbackToNativeInput();
              }}
            >
              Use System Camera
            </button>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        )}

        {/* Shutter flash overlay */}
        {flash && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: '#ffffff',
              zIndex: 30,
              opacity: 0.8,
            }}
          />
        )}
      </div>

      {/* Bottom Controls */}
      <div
        style={{
          padding: '1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10,
        }}
      >
        {!error && (
          <button
            className="shutter-btn"
            style={{ width: '68px', height: '68px' }}
            onClick={handleSnap}
            aria-label="Take picture"
          >
            <Camera size={32} />
          </button>
        )}
      </div>
    </div>
  );
};
