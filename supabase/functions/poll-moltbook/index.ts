// Supabase Edge Function: Poll Moltbook and generate responses
// Triggered by GitHub Actions on a schedule
// Uses OpenAI API - key stored securely in Supabase secrets (not exposed to internet)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MOLTBOOK_API = "https://www.moltbook.com/api/v1";

interface MoltbookPost {
  id: string;
  title: string;
  content: string;
  submolt: string;
  author: string;
  created_at: string;
  comments?: MoltbookComment[];
}

interface MoltbookComment {
  id: string;
  content: string;
  author: string;
  created_at: string;
}

// OpenAI chat completion helper
async function openaiChat(
  apiKey: string,
  system: string,
  user: string,
  options: { model?: string; maxTokens?: number; json?: boolean } = {}
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || "gpt-4o",
      max_tokens: options.maxTokens || 500,
      response_format: options.json ? { type: "json_object" } : undefined,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get OpenAI API key from secure Supabase secrets
    // This is NEVER exposed to the internet - only accessible server-side
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY not configured in Supabase secrets");
    }

    // Get agent config
    const { data: config, error: configError } = await supabase
      .from("agent_config")
      .select("*")
      .single();

    if (configError || !config) {
      throw new Error("Agent config not found");
    }

    const moltbookApiKey = config.api_key;
    if (!moltbookApiKey) {
      throw new Error("Moltbook API key not configured");
    }

    // Fetch recent posts from target submolts
    const posts: MoltbookPost[] = [];
    for (const submolt of config.target_submolts) {
      const response = await fetch(
        `${MOLTBOOK_API}/submolts/${submolt}/posts?limit=10`,
        {
          headers: { Authorization: `Bearer ${moltbookApiKey}` },
        }
      );

      if (response.ok) {
        const data = await response.json();
        posts.push(...data.posts);
      }
    }

    // Filter out posts we've already seen
    const { data: seenPosts } = await supabase
      .from("seen_posts")
      .select("moltbook_post_id");

    const seenPostIds = new Set(seenPosts?.map((p) => p.moltbook_post_id) || []);
    const newPosts = posts.filter((p) => !seenPostIds.has(p.id));

    // Analyze posts and decide which to reply to
    const postsToReply: MoltbookPost[] = [];

    for (const post of newPosts.slice(0, 5)) {
      // Limit to 5 per run
      const isRelevant = await checkRelevance(openaiApiKey, post, config);
      if (isRelevant) {
        postsToReply.push(post);
      }

      // Mark as seen regardless
      await supabase
        .from("seen_posts")
        .upsert({ moltbook_post_id: post.id });
    }

    // Generate replies for relevant posts
    const drafts = [];
    for (const post of postsToReply) {
      const draft = await generateReply(openaiApiKey, post, config);

      // Insert into queue
      const { data: inserted } = await supabase
        .from("post_queue")
        .insert({
          type: "reply",
          content: draft.content,
          submolt: post.submolt,
          reply_to_post_id: post.id,
          context: {
            original_post: {
              id: post.id,
              title: post.title,
              content: post.content,
              author: post.author,
              submolt: post.submolt,
            },
            generated_at: new Date().toISOString(),
          },
        })
        .select()
        .single();

      if (inserted) {
        // Set root_draft_id to self for first generation
        await supabase
          .from("post_queue")
          .update({ root_draft_id: inserted.id })
          .eq("id", inserted.id);

        drafts.push(inserted);

        // Log activity
        await supabase.from("activity_log").insert({
          action: "generated",
          post_queue_id: inserted.id,
          details: { type: "reply", to_post: post.id },
        });

        // If auto-post is enabled, post immediately
        if (config.auto_post) {
          await postToMoltbook(supabase, inserted.id, moltbookApiKey);
        }
      }
    }

    // Also check if we should create an original post
    const { data: recentPosts } = await supabase
      .from("post_queue")
      .select("created_at")
      .eq("type", "post")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastPostTime = recentPosts?.[0]?.created_at;
    const minutesSinceLastPost = lastPostTime
      ? (Date.now() - new Date(lastPostTime).getTime()) / 60000
      : Infinity;

    if (minutesSinceLastPost >= config.post_frequency_minutes) {
      const originalPost = await generateOriginalPost(openaiApiKey, config);

      const { data: inserted } = await supabase
        .from("post_queue")
        .insert({
          type: "post",
          title: originalPost.title,
          content: originalPost.content,
          submolt: originalPost.submolt,
          context: {
            generated_at: new Date().toISOString(),
            trigger: "scheduled",
          },
        })
        .select()
        .single();

      if (inserted) {
        await supabase
          .from("post_queue")
          .update({ root_draft_id: inserted.id })
          .eq("id", inserted.id);

        drafts.push(inserted);

        if (config.auto_post) {
          await postToMoltbook(supabase, inserted.id, moltbookApiKey);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        posts_checked: newPosts.length,
        drafts_created: drafts.length,
        auto_posted: config.auto_post,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

// Check if a post is relevant to our agent's focus
async function checkRelevance(
  apiKey: string,
  post: MoltbookPost,
  config: any
): Promise<boolean> {
  const response = await openaiChat(
    apiKey,
    `You determine if posts are relevant to these topics: ${config.topics.join(", ")}. Reply only "yes" or "no".`,
    `Title: ${post.title}\nContent: ${post.content}`,
    { model: "gpt-4o-mini", maxTokens: 10 }
  );

  return response.toLowerCase().includes("yes");
}

// Generate a reply to a post
async function generateReply(
  apiKey: string,
  post: MoltbookPost,
  config: any
): Promise<{ content: string }> {
  const content = await openaiChat(
    apiKey,
    `${config.persona}

You are responding to a post on Moltbook (a social network for AI agents).
Keep responses concise (2-4 sentences), insightful, and conversational.
Don't be sycophantic. Share genuine perspectives.
Never start with "Great post!" or similar.`,
    `Reply to this post in ${post.submolt}:

Title: ${post.title}
Author: @${post.author}
Content: ${post.content}`,
    { model: "gpt-4o", maxTokens: 500 }
  );

  return { content };
}

// Generate an original post
async function generateOriginalPost(
  apiKey: string,
  config: any
): Promise<{ title: string; content: string; submolt: string }> {
  const submolt =
    config.target_submolts[
      Math.floor(Math.random() * config.target_submolts.length)
    ];

  const response = await openaiChat(
    apiKey,
    `${config.persona}

You are creating an original post for Moltbook (a social network for AI agents).
Write something thoughtful about your focus areas.
Format your response as JSON: {"title": "...", "content": "..."}
Keep titles under 100 characters. Content should be 2-5 sentences.`,
    `Create an original post for the ${submolt} submolt. Share an insight, ask a question, or start a discussion.`,
    { model: "gpt-4o", maxTokens: 600, json: true }
  );

  const parsed = JSON.parse(response);
  return { ...parsed, submolt };
}

// Post content to Moltbook
async function postToMoltbook(
  supabase: any,
  queueId: string,
  apiKey: string
): Promise<void> {
  const { data: draft } = await supabase
    .from("post_queue")
    .select("*")
    .eq("id", queueId)
    .single();

  if (!draft) return;

  let response;
  let moltbookId;

  if (draft.type === "post") {
    response = await fetch(`${MOLTBOOK_API}/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        submolt: draft.submolt,
        title: draft.title,
        content: draft.final_content || draft.content,
      }),
    });
    const data = await response.json();
    moltbookId = data.id;
  } else {
    response = await fetch(
      `${MOLTBOOK_API}/posts/${draft.reply_to_post_id}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: draft.final_content || draft.content,
        }),
      }
    );
    const data = await response.json();
    moltbookId = data.id;
  }

  if (response.ok) {
    await supabase
      .from("post_queue")
      .update({
        status: "posted",
        posted_at: new Date().toISOString(),
        [draft.type === "post" ? "moltbook_post_id" : "moltbook_comment_id"]:
          moltbookId,
      })
      .eq("id", queueId);

    await supabase.from("activity_log").insert({
      action: "posted",
      post_queue_id: queueId,
      details: { moltbook_id: moltbookId },
    });
  }
}
