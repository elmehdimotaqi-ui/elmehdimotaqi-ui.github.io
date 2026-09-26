// Everything site-wide that you may want to change lives here.
export const SITE = {
  // Shown in the header, the browser tab and the RSS feed.
  title: 'Notes',
  // Shown in the footer and on the About page.
  author: 'Elmehdi MOTAQI',
  // Used in the page metadata and the RSS feed.
  description: 'Notes on what I learn while building software.',
  // Words per minute used for the reading-time estimate on each post.
  wordsPerMinute: 250,
  // GoatCounter site code, the part before .goatcounter.com. Empty string disables analytics.
  goatcounter: 'motaqi',
} as const;
