import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Every Markdown file under src/content/blog/ is a post.
// The file name is the URL: src/content/blog/my-post.md -> /posts/my-post/
const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    // One or two sentences, shown under the title and in the post list.
    description: z.string().optional(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    // One word each, lowercase: they become URLs under /tags/.
    tags: z.array(z.string()).default([]),
    // A draft is not built at all: no page, no list entry, no feed item.
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
