// Shared types used by both App.tsx and VideoEditor.tsx

export interface AudioTrackInfo {
  index:    number;
  label:    string;
  language: string;
}

export interface VideoInfo {
  duration_secs: number;
  size_mb:       number;
  bitrate_kbps:  number;
  width:         number;
  height:        number;
  audio_tracks?: AudioTrackInfo[];
}

export interface VideoEdits {
  trimStart:   number;
  trimEnd:     number;
  audioTracks: { index: number; volume: number; deleted: boolean }[];
}
