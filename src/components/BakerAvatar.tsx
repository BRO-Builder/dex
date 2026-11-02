import { useEffect, useState } from "react";

export function BakerAvatar({ keyHash, label, logo }: { keyHash: string; label?: string; logo?: string }) {
  const [failed, setFailed] = useState(false);
  const src = logo ?? `https://services.tzkt.io/v1/avatars/${keyHash}`;

  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return <span className="baker-avatar baker-avatar-fallback" aria-hidden="true">{(label ?? "?").charAt(0).toUpperCase()}</span>;
  }
  return <img className="baker-avatar" src={src} alt="" aria-hidden="true" loading="lazy" onError={() => setFailed(true)} />;
}
