declare global {
    var DATA_ROOT: string;
    var FORCE_GLOBAL_MODE: boolean;
    var COMMAND_LINE_ARGS: any;
    var SillyTavern: any;
}

export {};

declare global {
    var $: any;
    var jQuery: any;
    interface Error {
        code?: string;
    }
    interface JQuery<TElement = HTMLElement> {
        ajax(settings: any): any;
    }
    namespace NodeJS {
        interface Process {
            serverEvents: any;
        }
    }
}
