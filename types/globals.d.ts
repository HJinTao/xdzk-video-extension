declare namespace chrome {
  namespace runtime {
    const id: string;
    function getURL(path: string): string;
    function sendMessage(message: any): Promise<any>;
    const onMessage: {
      addListener(callback: (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void): void;
    };
  }
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: {
      addListener(callback: (changes: Record<string, { oldValue?: any; newValue?: any }>, areaName: string) => void): void;
      removeListener(callback: (changes: Record<string, { oldValue?: any; newValue?: any }>, areaName: string) => void): void;
    };
  }
  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  }
  namespace tabs {
    function get(tabId: number): Promise<any>;
    function query(queryInfo: Record<string, any>): Promise<any[]>;
    function create(createProperties: { url: string }): Promise<any>;
    const onUpdated: { addListener(callback: (tabId: number, changeInfo: any, tab: any) => void): void };
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
  }
  namespace scripting {
    function executeScript(injection: Record<string, any>): Promise<Array<{ result?: any }>>;
  }
  namespace webRequest {
    const onHeadersReceived: {
      addListener(callback: (details: any) => void, filter: { urls: string[] }, extraInfoSpec?: string[]): void;
    };
  }
  namespace downloads {
    function download(options: Record<string, any>): Promise<number>;
    function search(query: Record<string, any>): Promise<any[]>;
    function pause(downloadId: number): Promise<void>;
    function resume(downloadId: number): Promise<void>;
    function cancel(downloadId: number): Promise<void>;
  }
}

