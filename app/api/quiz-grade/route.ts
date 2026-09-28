/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  consumeActionRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
}

export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const fail = (code: ApiErrorCode, status: number, error: string, details?: string) =>
      withOwnerResponseHeaders(apiError(code, status, error, details), responseHeaders);
    try {
      await consumeActionRateLimit(ownerId, 'quiz_grade');
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return fail('RATE_LIMITED', 429, 'Too many grading requests');
      }
      return fail('INTERNAL_ERROR', 503, 'Rate limiting is unavailable');
    }
    const done = (data: Record<string, unknown>, status = 200) =>
      withOwnerResponseHeaders(apiSuccess(data, status), responseHeaders);
    let questionSnippet: string | undefined;
    let resolvedPoints: number | undefined;
    try {
      const body = (await req.json()) as GradeRequest;
      const { question, userAnswer, points, commentPrompt, language } = body;
      questionSnippet = question?.substring(0, 60);
      resolvedPoints = points;

      if (!question || !userAnswer) {
        return fail('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
      }

      // Validate points is a positive finite number
      if (!points || !Number.isFinite(points) || points <= 0) {
        return fail('INVALID_REQUEST', 400, 'points must be a positive number');
      }

      // Resolve model from request headers/body
      const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
        req,
        body,
        'quiz-grade',
      );

      const isZh = language === 'zh-CN';

      const systemPrompt = isZh
        ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
        : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

      const userPrompt = isZh
        ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
        : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
        },
        'quiz-grade',
        undefined,
        thinkingConfig,
      );

      // Parse the LLM response as JSON
      const text = result.text.trim();
      let gradeResult: GradeResponse;

      try {
        // Try to extract JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found');
        const parsed = JSON.parse(jsonMatch[0]);
        gradeResult = {
          score: Math.max(0, Math.min(points, Math.round(Number(parsed.score)))),
          comment: String(parsed.comment || ''),
        };
      } catch {
        // Fallback: give partial credit with a generic comment
        gradeResult = {
          score: Math.round(points * 0.5),
          comment: isZh
            ? '已作答，请参考标准答案。'
            : 'Answer received. Please refer to the standard answer.',
        };
      }

      return done({ ...gradeResult });
    } catch (error) {
      log.error(
        `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
        error,
      );
      return fail('INTERNAL_ERROR', 500, 'Failed to grade answer');
    }
  });
}
