import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Loader } from "@/components/motion/loader";

/** Session-scoped hand-off from a `/join#CODE` link to the library page. */
export const PENDING_ROOM_KEY = "leaflet.pending-room";
const LEADING_HASH = /^#/u;

export function takePendingRoomCode(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_ROOM_KEY);
    if (value !== null) {
      sessionStorage.removeItem(PENDING_ROOM_KEY);
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * `https://leaflet.chat/join#ABCD-EFGH-JKLM` lands here. The code lives in
 * the fragment, so it never reaches a server; we stash it for the home page
 * (which owns the book and the reading session) and go there.
 */
export function JoinPage() {
  const navigate = useNavigate();
  useEffect(() => {
    const raw = window.location.hash.replace(LEADING_HASH, "");
    try {
      sessionStorage.setItem(PENDING_ROOM_KEY, decodeURIComponent(raw));
    } catch {
      // Storage is unavailable: the home page will simply open without a code.
    }
    navigate("/", { replace: true });
  }, [navigate]);
  return (
    <div className="grid h-full place-items-center">
      <Loader label="Opening the reading room" variant="dots" />
    </div>
  );
}

export const Component = JoinPage;
