-- v1.5: lets a user pick which of their provider's models chat should use
-- (Task 4 of the chat-and-images-v2 plan). Nullable, same as image_model --
-- a user can configure a provider before deciding on a chat model.
alter table user_provider_settings add column chat_model text;
