export const DISCOVERY_TOPICS = [
  { id: "literature", label: "文学" },
  { id: "mystery", label: "悬疑" },
  { id: "science_fiction", label: "科幻" },
  { id: "fantasy", label: "奇幻" },
  { id: "history", label: "历史" },
  { id: "biography", label: "传记" },
  { id: "psychology", label: "心理" },
  { id: "travel", label: "旅行" },
] as const;

export type DiscoveryTopic = (typeof DISCOVERY_TOPICS)[number]["id"];
export type DiscoveryLanguage = "all" | "zh" | "en";
export type DiscoverySelection =
  | { kind: "topic"; value: DiscoveryTopic }
  | { kind: "search"; value: string };

export interface DiscoveryBook {
  workId: string;
  title: string;
  author: string;
  year: number | null;
  coverUrl: string | null;
  sourceUrl: string;
}

export interface DiscoveryPage {
  books: DiscoveryBook[];
  page: number;
  hasMore: boolean;
}

export interface DiscoveryDetail {
  description: string | null;
  subjects: string[];
}
