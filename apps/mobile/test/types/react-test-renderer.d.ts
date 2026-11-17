// The tests query mocked host components by name (`findByType('Sheet')`), which
// @types/react-test-renderer rejects. react-native-gesture-handler 2.31 pulls
// those types in transitively, so tsconfig `paths` points the import here to
// keep the loose surface the tests were written against.
export const act: any
export const create: any
