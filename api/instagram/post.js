export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { shortcode, type = 'post' } = req.query;
  if (!shortcode) return res.status(400).json({ success: false, error: 'Shortcode required' });

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'RAPIDAPI_KEY not configured in Vercel env vars' });

  const isReel = type === 'reel';
  const mediaUrl = isReel
    ? `https://www.instagram.com/reel/${shortcode}/`
    : `https://www.instagram.com/p/${shortcode}/`;

  try {
    const r = await fetch(
      `https://instagram-scraper-stable-api.p.rapidapi.com/get_media_data.php?reel_post_code_or_url=${encodeURIComponent(mediaUrl)}&type=${isReel ? 'reel' : 'post'}`,
      { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'instagram-scraper-stable-api.p.rapidapi.com' } }
    );

    if (!r.ok) return res.status(r.status).json({ success: false, error: `RapidAPI returned ${r.status}` });

    const data = await r.json();

    // Handle various possible response shapes
    const media = data?.data || data?.media || data?.items?.[0] || data;
    const thumbnailUrl =
      media?.display_url ||
      media?.thumbnail_url ||
      media?.image_versions2?.candidates?.[0]?.url ||
      media?.carousel_media?.[0]?.display_url;

    const caption =
      media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
      media?.caption?.text ||
      media?.title || '';

    if (!thumbnailUrl) {
      return res.status(404).json({ success: false, error: 'Post not found or is private' });
    }

    return res.status(200).json({
      success: true,
      thumbnailUrl,
      caption,
      authorName: media?.owner?.username || media?.user?.username || ''
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
