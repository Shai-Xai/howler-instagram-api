const HOST = 'instagram-scraper-stable-api.p.rapidapi.com';
const BASE = `https://${HOST}`;

function rapidHeaders(apiKey) {
  return { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST };
}

function formBody(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function mapMediaItem(n, mediaType) {
  const node = n?.node || n;
  const thumb =
    node.display_url ||
    node.thumbnail_src ||
    node.image_versions2?.candidates?.[0]?.url ||
    node.thumbnail_url || '';
  const videoUrl =
    node.video_url ||
    node.video_versions?.[0]?.url || '';
  const isVideo = !!(node.is_video || node.media_type === 2 || node.video_url || node.video_versions?.length);
  return {
    id: node.id || node.pk || '',
    shortcode: node.shortcode || node.code || '',
    displayUrl: thumb,
    thumbnailUrl: thumb,
    videoUrl: isVideo ? videoUrl : '',
    caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || '',
    likes: node.edge_liked_by?.count || node.like_count || 0,
    comments: node.edge_media_to_comment?.count || node.comment_count || 0,
    isVideo,
    mediaType: mediaType || (isVideo ? 'video' : 'image'),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { username } = req.query;
  if (!username) return res.status(400).json({ success: false, error: 'Username required' });

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'RAPIDAPI_KEY not configured' });

  const clean = username.replace(/^@/, '').trim();
  const igUrl = clean.startsWith('http') ? clean : `https://www.instagram.com/${clean}/`;

  try {
    const [profileRes, postsRes, reelsRes, storiesRes] = await Promise.allSettled([
      // Profile + basic posts
      fetch(`${BASE}/ig_get_fb_profile_hover.php?username_or_url=${encodeURIComponent(igUrl)}`,
        { headers: rapidHeaders(apiKey) }),
      // Extended posts
      fetch(`${BASE}/get_ig_user_posts.php`, {
        method: 'POST',
        headers: { ...rapidHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ username_or_url: igUrl, amount: 12 }),
      }),
      // Reels
      fetch(`${BASE}/get_ig_user_reels.php`, {
        method: 'POST',
        headers: { ...rapidHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ username_or_url: igUrl, amount: 12 }),
      }),
      // Stories
      fetch(`${BASE}/get_ig_user_stories.php`, {
        method: 'POST',
        headers: { ...rapidHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ username_or_url: igUrl, amount: 12 }),
      }),
    ]);

    // --- Profile ---
    let profile = null;
    if (profileRes.status === 'fulfilled' && profileRes.value.ok) {
      const d = await profileRes.value.json();
      const u = d?.user_data || d?.data?.user || d?.user || null;
      if (u) {
        profile = {
          username: u.username || clean,
          fullName: u.full_name || '',
          bio: u.biography || u.bio || '',
          profilePic: u.profile_pic_url_hd || u.profile_pic_url || '',
          followers: u.edge_followed_by?.count || u.follower_count || 0,
          following: u.edge_follow?.count || u.following_count || 0,
          postsCount: u.edge_owner_to_timeline_media?.count || u.media_count || 0,
          isPrivate: !!u.is_private,
          isVerified: !!u.is_verified,
        };
      }
    }
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

    // --- Posts ---
    let posts = [];
    if (postsRes.status === 'fulfilled' && postsRes.value.ok) {
      const d = await postsRes.value.json();
      const raw = d?.posts || d?.data || d?.items || [];
      posts = raw.map(p => mapMediaItem(p, 'post'));
    }

    // --- Reels ---
    let reels = [];
    let _reelDebug = null;
    if (reelsRes.status === 'fulfilled' && reelsRes.value.ok) {
      const d = await reelsRes.value.json();
      const raw = d?.reels || d?.data || d?.items || [];
      _reelDebug = { topKeys: Object.keys(d), item0Keys: raw[0] ? Object.keys(raw[0]) : null, item0: raw[0] || null };
      reels = raw.map(r => mapMediaItem(r, 'reel'));
    }

    // --- Stories ---
    let stories = [];
    if (storiesRes.status === 'fulfilled' && storiesRes.value.ok) {
      const d = await storiesRes.value.json();
      const raw = Array.isArray(d) ? d : (d?.data || d?.items || []);
      stories = raw.slice(0, 12).map(s => mapMediaItem(s, 'story'));
    }

    // Debug: show raw first items so we can see field names
    return res.status(200).json({ success: true, profile, posts, reels, stories, _reelDebug });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
