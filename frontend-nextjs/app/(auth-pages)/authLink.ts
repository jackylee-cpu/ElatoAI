/**
 * Link between /login and /signup that keeps the toy and character the visitor
 * arrived with, so switching forms does not lose them.
 */
export function authLink(
  path: "/login" | "/signup",
  toy_id?: string,
  personality_id?: string,
): string {
  const params = new URLSearchParams();
  if (toy_id) params.set("toy_id", toy_id);
  if (personality_id) params.set("personality_id", personality_id);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
