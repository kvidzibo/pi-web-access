export type RecencyFilter = "day" | "week" | "month" | "year";
export type SearchProvider = "auto" | "exa" | "duckduckgo";
export type FetchMode = "readable" | "raw";
export type FindMode = "exact" | "case-insensitive" | "fuzzy";

export type SearchHit = {
	title: string;
	url: string;
	snippet: string;
};

export type QueryResult = {
	query: string;
	provider: string;
	answer: string;
	hits: SearchHit[];
	error?: string;
};

export type PageResult = {
	url: string;
	finalUrl: string;
	title: string;
	content: string;
	contentType: string;
	error?: string;
};

export type StoredRecord = {
	id: string;
	createdAt: number;
	kind: "search" | "fetch";
	queries: QueryResult[];
	pages: PageResult[];
};
