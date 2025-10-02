import { Router } from 'express';
import { isAuthenticated } from '../middleware/auth';
import { ActivityTracker } from '../utils/activityTracker';
import { sql } from '../db';

const router = Router();

// Get user's activity history
router.get('/activities', isAuthenticated, async (req: any, res: any) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    
    const activities = await ActivityTracker.getUserActivities(req.user.id, page, limit);
    
    res.json(activities);
  } catch (error) {
    console.error('Error fetching user activities:', error);
    res.status(500).json({ 
      message: 'Failed to fetch activity history',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get user's login statistics
router.get('/login-stats', isAuthenticated, async (req: any, res: any) => {
  try {
    const stats = await sql`
      SELECT 
        COUNT(*) as total_logins,
        COUNT(DISTINCT ip_address) as unique_locations,
        COUNT(DISTINCT user_agent) as unique_devices,
        MAX(created_at) as last_login,
        jsonb_object_agg(
          DISTINCT device_info->>'browser',
          COUNT(*) FILTER (WHERE device_info->>'browser' IS NOT NULL)
        ) as browser_stats,
        jsonb_object_agg(
          DISTINCT device_info->>'os',
          COUNT(*) FILTER (WHERE device_info->>'os' IS NOT NULL)
        ) as os_stats
      FROM user_activities
      WHERE user_id = ${req.user.id} AND activity_type = 'login' AND status = 'success'
      GROUP BY user_id
    `;

    res.json(stats[0] || {
      total_logins: 0,
      unique_locations: 0,
      unique_devices: 0,
      last_login: null,
      browser_stats: {},
      os_stats: {}
    });
  } catch (error) {
    console.error('Error fetching login stats:', error);
    res.status(500).json({ 
      message: 'Failed to fetch login statistics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;