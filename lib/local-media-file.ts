import { File } from 'expo-file-system';

export function readLocalMedia(uri: string): Promise<ArrayBuffer> {
  return new File(uri).arrayBuffer();
}
