// api/auth.js
// Handles YouTube OAuth: /api/auth?action=url  →  returns Google login URL
//                        /api/auth?code=...    →  exchanges code, fetches videos, returns data

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, code } = req.query;
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.REDIRECT_URI; // e.g. https://yourapp.vercel.app/api/auth

  // ── Step 1: Return the Google OAuth URL ──────────────────────────────────
  if (action === 'url') {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly'
      ].join(' '),
      access_type: 'online',
      prompt: 'select_account'
    });

    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── Step 2: Exchange auth code for access token ───────────────────────────
  if (code) {
    try {
      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });

      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error('Failed to get access token');

      const accessToken = tokens.access_token;

      // ── Fetch channel info ──────────────────────────────────────────────
      const channelRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const channelData = await channelRes.json();
      const channel = channelData.items?.[0];
      if (!channel) throw new Error('No channel found for this account');

      const channelId = channel.id;
      const channelName = channel.snippet.title;
      const subscribers = formatNumber(channel.statistics.subscriberCount);
      const totalVideos = channel.statistics.videoCount;

      // ── Fetch videos (most recent 50) ───────────────────────────────────
      const searchRes = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=50&order=date&type=video`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const searchData = await searchRes.json();
      const videoIds = (searchData.items || []).map(v => v.id.videoId).join(',');

      // ── Fetch video stats ────────────────────────────────────────────────
      const statsRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const statsData = await statsRes.json();
      const videos = (statsData.items || []).map(v => ({
        title: v.snippet.title,
        published: v.snippet.publishedAt?.slice(0, 10),
        views: parseInt(v.statistics.viewCount || 0),
        likes: parseInt(v.statistics.likeCount || 0),
        comments: parseInt(v.statistics.commentCount || 0),
        duration: v.contentDetails.duration
      }));

      // Sort by views to get top/bottom performers
      const sorted = [...videos].sort((a, b) => b.views - a.views);
      const top5 = sorted.slice(0, 5);
      const bottom5 = sorted.slice(-5).reverse();
      const recent5 = videos.slice(0, 5);
      const avgViews = Math.round(videos.reduce((s, v) => s + v.views, 0) / videos.length);

      // Return everything the frontend needs
      return res.json({
        channelName,
        subscribers,
        totalVideos,
        avgViews: formatNumber(avgViews),
        top5,
        bottom5,
        recent5
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid request' });
}

function formatNumber(n) {
  n = parseInt(n);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}
