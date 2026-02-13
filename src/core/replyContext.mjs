export function createReplyContext(ttlMs) {
  const lastReplyTarget = new Map();

  function setReplyContext(userId, channelId, messageId) {
    lastReplyTarget.set(`${userId}:${channelId}`, {
      messageId,
      ts: Date.now(),
    });
  }

  function getReplyContext(userId, channelId) {
    const key = `${userId}:${channelId}`;
    const v = lastReplyTarget.get(key);
    if (!v) return null;
    if (Date.now() - v.ts > ttlMs) {
      lastReplyTarget.delete(key);
      return null;
    }
    return v.messageId;
  }

  return { setReplyContext, getReplyContext };
}
