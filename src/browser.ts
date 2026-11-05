// http(s) URLs in chat text, first two; trailing punctuation is not part of the URL.
export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/gi) ?? []).slice(0, 2);
}
