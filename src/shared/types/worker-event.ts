import { PipelineStage } from './pipeline-stage';
import { TrelloCredentials } from '../../trello/types';

export interface WorkerEvent {
  /** The Trello card ID to process */
  cardId: string;

  /** The Trello board ID the card belongs to */
  boardId: string;

  /** Which pipeline stage to execute */
  stage: PipelineStage;

  /** Git repository URL to clone/work in */
  repoUrl: string;

  /** Base branch to create feature branches from (e.g. "main") */
  baseBranch: string;

  /** Branch name prefix (e.g. "feat/", "fix/") */
  branchPrefix: string;

  /** Project-specific rules for Claude to follow */
  rules: string[];

  /** The Trello list ID where the card originated before entering the pipeline */
  originListId: string;

  /** Human-readable project name for logging/comments */
  projectName: string;

  /** Trello API credentials for card operations */
  trelloCredentials: TrelloCredentials;

  /** Whether this card was reopened from Done (a retry of a previous implementation) */
  isRetry?: boolean;

  /** Stakeholder feedback from Trello comments explaining why the previous implementation failed */
  retryFeedback?: string;
}
