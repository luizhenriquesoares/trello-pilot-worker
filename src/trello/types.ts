export interface TrelloCredentials {
  key: string;
  token: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  shortUrl: string;
}

export interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
}

export interface TrelloChecklist {
  id: string;
  name: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
}

export interface TrelloCard {
  id: string;
  idShort: number;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  idList: string;
  idBoard: string;
  labels: TrelloLabel[];
  due: string | null;
  dueComplete: boolean;
  idMembers: string[];
  checklists?: TrelloChecklist[];
  attachments?: TrelloAttachment[];
  listName?: string;
  boardName?: string;
  originListId?: string;
  originListName?: string;
}

export interface TrelloMember {
  id: string;
  fullName: string;
  username: string;
}
