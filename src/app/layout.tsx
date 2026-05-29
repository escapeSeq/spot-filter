import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spot Filter – Spotify Playlist Editor",
  description: "Retrieve, edit, and recreate Spotify playlists via JSON",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
