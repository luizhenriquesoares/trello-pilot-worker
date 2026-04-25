export interface ProjectList {
  /**
   * Trello list id for projects with a dedicated workflow list. Optional —
   * projects without an `id` are routed via the triage list + a Trello label
   * matching the `name` field.
   */
  id?: string;
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
  /**
   * Optional shared list where cards for projects without their own list land.
   * The worker resolves the repo for those cards by reading their Trello label
   * (matched against `ProjectList.name`). If unset, label-based routing is
   * disabled and only projects with `id` are reachable.
   */
  triageListId?: string;
  projectLists: ProjectList[];
  rules: string[];
}

export interface EnvConfig {
  port: number;
  sqsQueueUrl: string;
  awsRegion: string;
  claudeOauthToken: string;
  ghToken: string;
  trelloKey: string;
  trelloToken: string;
  trelloWebhookSecret?: string;
  publicBaseUrl?: string;
  slackWebhookUrl?: string;
}
