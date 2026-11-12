export type ImportKind='video'|'audio'|'image';
const supported:Record<string,ImportKind>={mp4:'video',mov:'video',webm:'video',mkv:'video',mp3:'audio',wav:'audio',m4a:'audio',aac:'audio',flac:'audio',ogg:'audio',png:'image',jpg:'image',jpeg:'image',webp:'image'};
export const fileTransfer=(types:readonly string[])=>types.includes('Files');
/** Match the existing media importer; reject a whole multi-file drop atomically. */
export function droppedMedia<T extends {name:string;size:number}>(files:readonly T[]):{file:T;kind:ImportKind}|{error:string} {
  if(files.length!==1)return {error:files.length?'Drop one file at a time. Nothing from this drop was imported.':'Drop a video, audio, or PNG/JPEG/WebP image file.'};
  const file=files[0]!,extension=file.name.lastIndexOf('.')>0?file.name.split('.').at(-1)?.toLowerCase():undefined,kind=extension?supported[extension]:undefined;
  if(!kind)return {error:'Supported files: MP4, MOV, WebM, MKV; MP3, WAV, M4A, AAC, FLAC, OGG; PNG, JPEG, WebP.'};
  if(file.size===0)return {error:'This file is empty. Choose a recording or image with media content.'};
  return {file,kind};
}
