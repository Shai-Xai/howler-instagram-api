export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { username } = req.query;
  if (!username) return res.status(400).json({ success: false, error: 'Username required' });

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'RAPIDAPI_KEY not configured in Vercel env vars' });

  const clean = username.replace(/^@/, '').trim();
  const usernameOrUrl = clean.startsWith('http') ? clean : `https://www.instagram.com/${clean}/`;

  try {
    const r = await fetch(
      `https://instagram-scraper-stable-api.p.rapidapi.com/ig_get_fb_profile_hover.php?username_or_url=${encodeURIComponent(usernameOrUrl)}`,
      { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'instagram-scraper-stable-api.p.rapidapi.com' } }
    );

    if (!r.ok) return res.status(r.status).json({ success: false, error: `RapidAPI returned ${r.status}` });

    const data = await r.json();

    // Handle various possible response shapes
    const user = data?.data?.user || data?.user || (data?.username ? data : null);
    if (!user?.username) return res.status(404).json({ success: false, error: 'User not found' });

    const edges = user.edge_owner_to_timeline_media?.edges || [];
    const posts = edges.map(e => {
      const n = e.node || e;
      return {
        id: n.id,
        shortcode: n.shortcode,
        displayUrl: n.display_url,
        thumbnailUrl: n.thumbnail_src || n.display_url,
        caption: n.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        likes: n.edge_liked_by?.count || 0,
        comments: n.edge_media_to_comment?.count || 0,
        isVideo: !!n.is_video
      };
    });

    return res.status(200).json({
      success: true,
      profile: {
        username: user.username,
        fullName: user.full_name || '',
        bio: user.biography || '',
        profilePic: user.profile_pic_url_hd || user.profile_pic_url || '',
        followers: user.edge_followed_by?.count || 0,
        following: user.edge_follow?.count || 0,
        postsCount: user.edge_owner_to_timeline_media?.count || 0,
        isPrivate: !!user.is_private,
        isVerified: !!user.is_verified
      },
      posts
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
