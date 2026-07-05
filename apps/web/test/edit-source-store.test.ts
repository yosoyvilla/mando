import { describe, it, expect, beforeEach } from "bun:test";
import { useEditSourceStore } from "../src/stores/edit-source-store";

function reset() {
  useEditSourceStore.setState({ pendingEditSource: null });
}

describe("useEditSourceStore", () => {
  beforeEach(reset);

  it("starts with no pending edit source", () => {
    expect(useEditSourceStore.getState().pendingEditSource).toBeNull();
  });

  it("setPendingEditSource stores the source for a later consumer", () => {
    const source = { dataUrl: "data:image/png;base64,AAAA", mime: "image/png", filename: "shot.png" };
    useEditSourceStore.getState().setPendingEditSource(source);
    expect(useEditSourceStore.getState().pendingEditSource).toEqual(source);
  });

  it("consumePendingEditSource returns the source and clears it, so a second read is null", () => {
    const source = { dataUrl: "data:image/png;base64,AAAA", mime: "image/png", filename: "shot.png" };
    useEditSourceStore.getState().setPendingEditSource(source);

    const first = useEditSourceStore.getState().consumePendingEditSource();
    expect(first).toEqual(source);

    const second = useEditSourceStore.getState().consumePendingEditSource();
    expect(second).toBeNull();
    expect(useEditSourceStore.getState().pendingEditSource).toBeNull();
  });
});
