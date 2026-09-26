import { getCollection, type CollectionEntry } from 'astro:content';
import { SITE } from '../site';

export type Post = CollectionEntry<'blog'>;

/** Published posts, newest first. Drafts are left out of every list, tag page and feed. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function postUrl(post: Post): string {
  return `/posts/${post.id}/`;
}

export function tagUrl(tag: string): string {
  return `/tags/${tag}/`;
}

/** 2026-09-26: unambiguous, and it sorts as text. The UTC date, so a timezone never shifts it by a day. */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A rough estimate from the raw Markdown. Code counts like prose, which is fair for a tutorial. */
export function readingTime(body: string | undefined): string {
  const words = (body ?? '').split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / SITE.wordsPerMinute));
  return `${minutes} min read`;
}

/** Every tag with the number of published posts carrying it, alphabetical. */
export async function getTags(): Promise<{ tag: string; count: number }[]> {
  const counts = new Map<string, number>();
  for (const post of await getPosts()) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}
