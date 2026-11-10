declare module "virtual:lanes-fixture-repo" {
  const fixture: {
    /** HEAD of the fixture (main). */
    head: string;
    /** First line of each commit message → full hash. */
    commits: Record<string, string>;
    /** Every file under .git, base64. */
    files: { path: string; b64: string }[];
  };
  export default fixture;
}
