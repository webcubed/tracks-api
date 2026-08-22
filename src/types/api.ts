export type ApiResponse<T> = { data: T };
export type ApiErrorResponse = { error: { code: string; message: string } };
