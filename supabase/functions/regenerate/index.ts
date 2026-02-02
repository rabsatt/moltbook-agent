// Supabase Edge Function: Regenerate a draft
// Called from the dashboard when user wants a new version
// Uses OpenAI API - key stored securely in Supabase secrets (not exposed to internet)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
    const { draft_id, feedback } = await req.json();

    if (!draft_id) {
      throw new Error("draft_id is required");
    }

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

    // Get original draft
    const { data: original, error: draftError } = await supabase
      .from("post_queue")
      .select("*")
      .eq("id", draft_id)
      .single();

    if (draftError || !original) {
      throw new Error("Draft not found");
    }

    // Get agent config for persona
    const { data: config } = await supabase
      .from("agent_config")
      .select("persona, topics")
      .single();

    // Get all previous attempts for this draft chain
    const rootId = original.root_draft_id || draft_id;
    const { data: previousAttempts } = await supabase
      .from("post_queue")
      .select("content, generation_attempt")
      .eq("root_draft_id", rootId)
      .order("generation_attempt", { ascending: true });

    const attemptNumber = original.generation_attempt + 1;

    // Build context about previous attempts
    const previousVersions = previousAttempts
      ?.map((a) => `Attempt ${a.generation_attempt}: "${a.content}"`)
      .join("\n\n");

    // Generate new version
    let newContent: string;
    let newTitle: string | undefined;

    if (original.type === "reply") {
      const context = original.context as any;
      newContent = await openaiChat(
        openaiApiKey,
        `${config?.persona || "You are a helpful AI agent."}

You are regenerating a reply for Moltbook (a social network for AI agents).
This is attempt #${attemptNumber}. Previous versions were not approved.
Try a DIFFERENT angle, tone, or approach. Don't repeat similar content.
Keep responses concise (2-4 sentences), insightful, and conversational.
${feedback ? `\nUser feedback on why previous version wasn't good: ${feedback}` : ""}`,
        `Original post to reply to:
Title: ${context.original_post?.title}
Author: @${context.original_post?.author}
Content: ${context.original_post?.content}

Previous attempts that weren't approved:
${previousVersions}

Generate a new, different reply.`,
        { model: "gpt-4o", maxTokens: 500 }
      );
    } else {
      // Original post regeneration
      const response = await openaiChat(
        openaiApiKey,
        `${config?.persona || "You are a helpful AI agent."}

You are regenerating an original post for Moltbook.
This is attempt #${attemptNumber}. Previous versions were not approved.
Try a DIFFERENT topic, angle, or style. Don't repeat similar content.
Format your response as JSON: {"title": "...", "content": "..."}
${feedback ? `\nUser feedback: ${feedback}` : ""}`,
        `Target submolt: ${original.submolt}

Previous attempts that weren't approved:
${previousVersions}

Generate a new, different post.`,
        { model: "gpt-4o", maxTokens: 600, json: true }
      );

      try {
        const parsed = JSON.parse(response);
        newContent = parsed.content;
        newTitle = parsed.title;
      } catch {
        newContent = response;
      }
    }

    // Mark old draft as superseded
    await supabase
      .from("post_queue")
      .update({ status: "superseded", decided_at: new Date().toISOString() })
      .eq("id", draft_id);

    // Insert new draft
    const { data: newDraft, error: insertError } = await supabase
      .from("post_queue")
      .insert({
        type: original.type,
        title: newTitle || original.title,
        content: newContent,
        submolt: original.submolt,
        reply_to_post_id: original.reply_to_post_id,
        reply_to_comment_id: original.reply_to_comment_id,
        context: original.context,
        generation_attempt: attemptNumber,
        root_draft_id: rootId,
      })
      .select()
      .single();

    if (insertError) {
      throw insertError;
    }

    // Log activity
    await supabase.from("activity_log").insert({
      action: "regenerated",
      post_queue_id: newDraft.id,
      details: {
        previous_draft_id: draft_id,
        attempt_number: attemptNumber,
        feedback: feedback || null,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        new_draft: newDraft,
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
