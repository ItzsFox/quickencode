// Shared types used by App.tsx and VideoEditor.tsx

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

/** Edits produced by VideoEditor and consumed by runEncode */
export interface VideoEdits {
  trimStart:        number;  // seconds
  trimEnd:          number;  // seconds
  audioTracks:      { index: number; volume: number; deleted: boolean }[];
  mergeAudioTracks: boolean; // mix all active tracks into one output stream
}
