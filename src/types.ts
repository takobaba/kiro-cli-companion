/**
 * Shared types.
 */

export type CliState =
    | { status: 'not_found' }
    | { status: 'not_authenticated' }
    | { status: 'ready'; cliPath: string };
