/**
 * Response normalizers. Douyin payloads are sparse: missing metrics must be
 * ``null``, never 0, because 0 and "unknown" mean different things in later
 * analysis. Every function here only reads known fields and never falls back
 * to a guessed value.
 */

const present = (value) => (value === undefined || value === null ? null : value);

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

export function videoUrl(awemeId) {
  return awemeId ? `https://www.douyin.com/video/${awemeId}` : null;
}

export function normalizeStats(stats) {
  if (!stats || typeof stats !== 'object') {
    return {
      plays: null, likes: null, comments: null, shares: null, collects: null,
    };
  }
  return {
    plays: numberOrNull(stats.play_count),
    likes: numberOrNull(stats.digg_count),
    comments: numberOrNull(stats.comment_count),
    shares: numberOrNull(stats.share_count),
    collects: numberOrNull(stats.collect_count),
  };
}

export function normalizeAuthor(author) {
  if (!author || typeof author !== 'object') {
    return { nickname: null, unique_id: null, sec_uid: null };
  }
  return {
    nickname: stringOrNull(author.nickname),
    unique_id: stringOrNull(author.unique_id) ?? stringOrNull(author.short_id),
    sec_uid: stringOrNull(author.sec_uid),
  };
}

export function normalizeAweme(aweme) {
  if (!aweme || typeof aweme !== 'object') return null;
  const awemeId = stringOrNull(aweme.aweme_id);
  return {
    aweme_id: awemeId,
    title: stringOrNull(aweme.desc),
    create_time: numberOrNull(aweme.create_time),
    media_type: numberOrNull(aweme.media_type),
    author: normalizeAuthor(aweme.author),
    stats: normalizeStats(aweme.statistics),
    url: videoUrl(awemeId),
    is_top: present(aweme.is_top),
  };
}

/** Search result -> {items, skipped, has_more, raw_count}. */
export function normalizeSearchPayload(data) {
  const result = data?.result ?? {};
  const rows = Array.isArray(result.data) ? result.data : [];
  const items = [];
  const skipped = [];
  rows.forEach((row, index) => {
    const aweme = row?.aweme_info;
    if (aweme) {
      const normalized = normalizeAweme(aweme);
      if (normalized) items.push(normalized);
      else skipped.push({ index, reason: 'empty_aweme' });
    } else {
      skipped.push({ index, reason: row?.user_list ? 'user_card' : 'no_aweme_info' });
    }
  });
  return {
    items,
    skipped,
    raw_count: rows.length,
    has_more: Boolean(data?.has_more),
    next_offset: data?.next_offset ?? null,
    logid: data?.logid ?? null,
  };
}

export function normalizeHotItems(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows.map((item, index) => ({
    rank: index + 1,
    position: numberOrNull(item?.position),
    title: stringOrNull(item?.word) ?? stringOrNull(item?.title),
    hot_value: numberOrNull(item?.hot_value),
    view_count: numberOrNull(item?.view_count),
    label: present(item?.label),
    sentence_id: stringOrNull(item?.sentence_id),
    word_type: numberOrNull(item?.word_type),
    search_url: item?.word
      ? `https://www.douyin.com/search/${encodeURIComponent(item.word)}`
      : null,
  }));
}

export function normalizeComments(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((item) => ({
    text: stringOrNull(item?.text),
    user: {
      nickname: stringOrNull(item?.user?.nickname),
      sec_uid: stringOrNull(item?.user?.sec_uid),
    },
    digg_count: numberOrNull(item?.digg_count),
    reply_count: numberOrNull(item?.reply_comment_total),
    create_time: numberOrNull(item?.create_time),
    is_author: present(item?.is_author),
  }));
}

export function normalizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    nickname: stringOrNull(user.nickname),
    unique_id: stringOrNull(user.unique_id) ?? stringOrNull(user.short_id),
    sec_uid: stringOrNull(user.sec_uid),
    signature: stringOrNull(user.signature),
    follower_count: numberOrNull(user.follower_count),
    following_count: numberOrNull(user.following_count),
    total_favorited: numberOrNull(user.total_favorited),
    aweme_count: numberOrNull(user.aweme_count),
    favoriting_count: numberOrNull(user.favoriting_count),
    city: stringOrNull(user.city),
    province: stringOrNull(user.province),
    ip_location: stringOrNull(user.ip_location),
    url: user.sec_uid ? `https://www.douyin.com/user/${user.sec_uid}` : null,
  };
}

/** Extract an aweme id from a plain id, a share URL, or a full Douyin URL. */
export function extractAwemeId(input) {
  if (!input) return null;
  const text = String(input).trim();
  if (/^\d{15,25}$/.test(text)) return text;
  const patterns = [
    /\/video\/(\d{15,25})/,
    /\/note\/(\d{15,25})/,
    /[?&]modal_id=(\d{15,25})/,
    /\/share\/video\/(\d{15,25})/,
    /(\d{15,25})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Extract a sec_uid from a profile URL or return a bare sec_uid. */
export function extractSecUid(input) {
  if (!input) return null;
  const text = String(input).trim();
  const match = text.match(/\/user\/([A-Za-z0-9_\-.]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_\-.]{20,}$/.test(text)) return text;
  return null;
}

/** Remove undefined recursively so results always satisfy the JSON boundary. */
export function jsonSafe(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = jsonSafe(item);
    }
    return out;
  }
  return null;
}
