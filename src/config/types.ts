export interface ProjectList {
  id: string;
  name: string;
  repoUrl: string;
  baseBranch: string;
  branchPrefix: string;
  rules?: string[];
}

export interface BoardConfig {
  boardId: string;
  lists: {
    doing: string;
    review: string;
    qa: string;
    done: string;
  };
  projectLists: ProjectList[];
  rules: string[];
}

export interface EnvConfig {
  port: number;
  sqsQueueUrl: string;
  awsRegion: string;
  anthropicApiKey: string;
  ghToken: string;
  trelloKey: string;
  trelloToken: string;
  trelloWebhookSecret?: string;
  slackWebhookUrl?: string;
}
