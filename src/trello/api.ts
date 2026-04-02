import {
  TrelloBoard,
  TrelloCard,
  TrelloChecklist,
  TrelloCredentials,
  TrelloList,
  TrelloMember,
} from './types';

const BASE_URL = 'https://api.trello.com/1';

export class TrelloApi {
  constructor(private credentials: TrelloCredentials) {}

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);

    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getBoards(): Promise<TrelloBoard[]> {
    return this.request<TrelloBoard[]>('/members/me/boards', {
      filter: 'open',
      fields: 'name,url,shortUrl',
    });
  }

  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return this.request<TrelloList[]>(`/boards/${boardId}/lists`, {
      filter: 'open',
    });
  }

  async getBoardCards(boardId: string): Promise<TrelloCard[]> {
    return this.request<TrelloCard[]>(`/boards/${boardId}/cards`, {
      fields: 'name,desc,url,shortUrl,idShort,idList,idBoard,labels,due,dueComplete,idMembers',
      attachments: 'true',
      checklists: 'all',
    });
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>(`/cards/${cardId}`, {
      fields: 'name,desc,url,shortUrl,idShort,idList,idBoard,labels,due,dueComplete,idMembers',
      attachments: 'true',
      checklists: 'all',
    });
  }

  async getCardChecklists(cardId: string): Promise<TrelloChecklist[]> {
    return this.request<TrelloChecklist[]>(`/cards/${cardId}/checklists`);
  }

  async moveCard(cardId: string, listId: string): Promise<TrelloCard> {
    return this.put<TrelloCard>(`/cards/${cardId}`, { idList: listId });
  }

  async addComment(cardId: string, text: string): Promise<void> {
    await this.post(`/cards/${cardId}/actions/comments`, { text });
  }

  async getMember(memberId: string): Promise<TrelloMember> {
    return this.request<TrelloMember>(`/members/${memberId}`, {
      fields: 'fullName,username',
    });
  }

  async getMe(): Promise<TrelloMember> {
    return this.request<TrelloMember>('/members/me', {
      fields: 'fullName,username',
    });
  }

  async getCardComments(cardId: string): Promise<{ text: string; author: string; date: string }[]> {
    const actions = await this.request<
      { data: { text: string }; memberCreator: { fullName: string }; date: string }[]
    >(`/cards/${cardId}/actions`, { filter: 'commentCard' });

    return actions.map((action) => ({
      text: action.data.text,
      author: action.memberCreator.fullName,
      date: action.date,
    }));
  }

  async createWebhook(
    callbackUrl: string,
    idModel: string,
    description: string,
  ): Promise<{ id: string; callbackURL: string }> {
    return this.post('/webhooks', {
      callbackURL: callbackUrl,
      idModel,
      description,
    });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const url = new URL(`${BASE_URL}/webhooks/${webhookId}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);
    const res = await fetch(url.toString(), { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
  }

  async listWebhooks(): Promise<
    { id: string; description: string; callbackURL: string; idModel: string; active: boolean }[]
  > {
    return this.request('/tokens/' + this.credentials.token + '/webhooks');
  }
}
