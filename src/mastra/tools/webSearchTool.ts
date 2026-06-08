import { createTool } from '@mastra/core/tools';
import Exa from 'exa-js';
import { z } from 'zod';
import 'dotenv/config';

// A backend-agnostic search result, before summarization.
type RawResult = {
	title: string;
	url: string;
	text: string;
};

// Which web-search backend to use. Defaults to Exa to preserve prior behavior;
// set WEB_SEARCH_PROVIDER=ollama in .env to try Ollama's web search instead.
const provider = (process.env.WEB_SEARCH_PROVIDER || 'exa').toLowerCase();

// How many results to feed into summarization (kept small for cost control).
const NUM_RESULTS = 2;

// Initialize Exa client (only used when the Exa backend is selected).
const exa = new Exa(process.env.EXA_API_KEY);

async function searchExa(query: string): Promise<RawResult[]> {
	if (!process.env.EXA_API_KEY) {
		throw new Error('Missing EXA_API_KEY');
	}

	const { results } = await exa.search(query, { numResults: NUM_RESULTS });

	return (results || []).map((result) => ({
		title: result.title || '',
		url: result.url,
		text: result.text || '',
	}));
}

async function searchOllama(query: string): Promise<RawResult[]> {
	if (!process.env.OLLAMA_API_KEY) {
		throw new Error('Missing OLLAMA_API_KEY');
	}

	const response = await fetch('https://ollama.com/api/web_search', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ query }),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Ollama web search failed (${response.status}): ${body}`);
	}

	const data = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};

	return (data.results || []).slice(0, NUM_RESULTS).map((result) => ({
		title: result.title || '',
		url: result.url || '',
		text: result.content || '',
	}));
}

export const webSearchTool = createTool({
	id: 'web-search',
	description:
		'Search the web for information on a specific query and return summarized content',
	inputSchema: z.object({
		query: z.string().describe('The search query to run'),
	}),
	execute: async (inputData, context) => {
		console.log('Executing web search tool');
		const { query } = inputData;

		try {
			console.log(`Searching web for: "${query}" (provider: ${provider})`);
			const results =
				provider === 'ollama'
					? await searchOllama(query)
					: await searchExa(query);

			if (!results || results.length === 0) {
				console.log('No search results found');
				return { results: [], error: 'No results found' };
			}

			console.log(
				`Found ${results.length} search results, summarizing content...`,
			);

			// Get the summarization agent
			const summaryAgent = context?.mastra?.getAgent('webSummarizationAgent');

			if (!summaryAgent) {
				console.error('Web summarization agent not found');
				return { results: [], error: 'Summarization agent not available' };
			}

			// Process each result with summarization
			const processedResults = [];
			for (const result of results) {
				try {
					// Skip if content is too short or missing
					if (!result.text || result.text.length < 100) {
						processedResults.push({
							title: result.title,
							url: result.url,
							content: result.text || 'No content available',
						});
						continue;
					}

					// Summarize the content
					const summaryResponse = await summaryAgent.generate([
						{
							role: 'user',
							content: `Please summarize the following web content for research query: "${query}"

Title: ${result.title || 'No title'}
URL: ${result.url}
Content: ${result.text.substring(0, 8000)}...

Provide a concise summary that captures the key information relevant to the research query.`,
						},
					]);

					processedResults.push({
						title: result.title,
						url: result.url,
						content: summaryResponse.text,
					});

					console.log(`Summarized content for: ${result.title || result.url}`);
				} catch (summaryError) {
					console.error('Error summarizing content:', summaryError);
					// Fallback to truncated original content
					processedResults.push({
						title: result.title,
						url: result.url,
						content: result.text
							? `${result.text.substring(0, 500)}...`
							: 'Content unavailable',
					});
				}
			}

			return {
				results: processedResults,
			};
		} catch (error) {
			console.error('Error searching the web:', error);
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error';
			console.error('Error details:', errorMessage);
			return {
				results: [],
				error: errorMessage,
			};
		}
	},
});
