export async function readLocalMedia(uri: string): Promise<ArrayBuffer> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error('The selected image could not be read.');
  return response.arrayBuffer();
}
