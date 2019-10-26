import * as R from 'ramda'
import _ from 'lodash'
import { Manager } from '@/utils/manager'
import storage from '@/utils/storage'

const STORAGE_LIST_LIMIT_KEY = '__oc_list_limit__'

class WaitStatusJob {
  constructor (status, data) {
    this.status = status
    this.data = data
    this.timer = null
  }
  /**
   * @description 清除定时器
   * @memberof WaitStatusJob
   */
  clearTimer () {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
  /**
   * @description 设置定时器进行状态检测
   * @memberof WaitStatusJob
   */
  start () {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.checkStatus()
    }, this.data.list.refreshInterval * 1000)
  }
  /**
   * @description 获取新数据，进行状态检测
   * @memberof WaitStatusJob
   */
  async checkStatus () {
    if (!this.data.list.manager) return
    const params = this.data.list.getOptionParams()
    try {
      const { data = {} } = await this.data.list.manager.get({
        id: this.data.id,
        params,
      })
      this.data.data = data
      const isSteadyStatus = this.data.isSteadyStatus(this.status)
      if (!isSteadyStatus) {
        this.start()
      } else {
        this.clearTimer()
      }
    } catch (error) {
      if (error.response.status === 404) {
        this.data.list.refresh()
        this.clearTimer()
      } else {
        this.data.setError(error)
        this.clearTimer()
      }
    }
  }
}

class DataWrap {
  constructor (list, data, idKey, index) {
    this.list = list
    this.id = data[idKey]
    this.data = data
    this.index = index
    this.error = null
  }
  /**
   * @description 开始轮询检测状态
   * @param {Object} steadyStatus
   * @memberof DataWrap
   */
  waitStatus (steadyStatus) {
    this.wait = new WaitStatusJob(steadyStatus, this)
    this.wait.start()
  }
  /**
   * @description 清除定时器，供List调用
   * @memberof DataWrap
   */
  clearWaitJob () {
    if (this.wait) {
      this.wait.clearTimer()
    }
  }
  /**
   * @description 设置数据错误信息，供WaitStatusJob调用
   * @param {Error} error
   * @memberof DataWrap
   */
  setError (error) {
    this.error = error
  }
  /**
   * @description 检测状态
   * @param {Object} steadyStatus
   * @returns {Boolean}
   * @memberof DataWrap
   */
  isSteadyStatus (steadyStatus) {
    let isSteadyStatus = true
    for (let key in steadyStatus) {
      const status = steadyStatus[key]
      const currentStatus = _.get(this.data, key)
      if (
        (R.is(String, status) && status === currentStatus) ||
        (R.is(Array, status) && status.includes(currentStatus)) ||
        /fail/.test(currentStatus)
      ) {
        isSteadyStatus = true
      } else {
        isSteadyStatus = false
        return isSteadyStatus
      }
    }
    return isSteadyStatus
  }
}

class CreateList {
  constructor (templateContext, {
    resource,
    apiVersion,
    ctx,
    getParams,
    limit = 20,
    idKey = 'id',
    filterOptions,
    filter = {},
    // 期望的状态，如果不符合预期，则进行定时更新
    steadyStatus = null,
    // 定时更新间隔时间，默认10s
    refreshInterval = 10,
  }) {
    // vm 实例
    this.templateContext = templateContext
    this.resource = resource
    this.ctx = ctx
    this.getParams = getParams
    if (R.is(String, resource)) {
      this.manager = new Manager(resource, apiVersion)
    }
    this.loading = false
    // 获取的数据
    this.data = {}
    // 分页信息
    this.offset = 0
    this.limit = limit
    this.total = 0
    // 选择数据
    this.selectedItems = []
    this.selected = []
    // 指定作为id的属性key值
    this.idKey = idKey
    // 自定义过滤配置
    this.filterOptions = filterOptions
    // 存放当前过滤的条件
    this.filter = filter
    this.steadyStatus = this.genSteadyStatus(steadyStatus)
    this.refreshInterval = refreshInterval
  }
  /**
   * @description 重置数据
   * @memberof CreateList
   */
  reset () {
    this.clearWaitJob()
    // 复位分页信息
    this.total = 0
    this.offset = 0
    // 重置数据
    this.data = {}
    this.clearSelected()
  }
  async fetchData (offset, limit) {
    this.loading = true
    this.params = this.genParams(offset, limit)
    try {
      let response
      if (R.is(String, this.resource)) {
        response = await this.manager.list({
          params: this.params,
          ctx: this.ctx,
        })
      } else {
        response = await this.resource(this.params)
      }
      if (this.templateContext._isDestroyed) return
      const {
        data: {
          data = [],
          total,
          limit: responseLimit,
          offset: responseOffset = 0,
        },
      } = response
      this.clearWaitJob()
      this.data = this.wrapData(data)
      this.checkSteadyStatus()
      if (total) {
        this.total = total
      } else {
        this.total = data.length
      }
      if (responseLimit > 0) {
        this.offset = responseOffset
      } else {
        this.offset = 0
      }
    } finally {
      this.loading = false
    }
  }
  /**
   * @description 刷新数据，不改变当前页数和条数
   * @memberof CreateList
   */
  refresh () {
    this.fetchData(this.offset, this.getLimit())
  }
  /**
   * @description 获取api资源相关的参数
   * @memberof CreateList
   */
  getOptionParams () {
    if (R.is(Function, this.getParams)) {
      return this.getParams() || {}
    }
    return this.getParams || {}
  }
  /**
   * @description 生成所有的请求参数
   * @param {Number} offset
   * @param {Number} limit
   * @returns {Object}
   * @memberof CreateList
   */
  genParams (offset, limit) {
    let params = {
      scope: this.templateContext.$store.getters.scope,
      ...this.getOptionParams(),
    }
    if (limit) {
      params.limit = limit
    } else {
      params.limit = this.getLimit()
    }
    if (offset) params.offset = offset
    params = {
      ...params,
      ...this.genFilterParams(params),
    }
    return params
  }
  /**
   * @description 生成期望的状态数据结构
   * @param {Array | String | Object} steadyStatus
   * @returns {Object}
   * @memberof CreateList
   */
  genSteadyStatus (steadyStatus) {
    if (R.is(Array, steadyStatus) || R.is(String, steadyStatus)) {
      return {
        status: steadyStatus,
      }
    }
    return steadyStatus
  }
  /**
   * @description 获取每页请求条数
   * @returns { Number }
   * @memberof CreateList
   */
  getLimit () {
    const limit = storage.get(STORAGE_LIST_LIMIT_KEY)
    return limit || this.limit
  }
  /**
   * @description 包装返回数据
   * @param {Array} arr
   * @returns {Object}
   * @memberof CreateList
   */
  wrapData (arr) {
    const data = {}
    for (let i = 0, len = arr.length; i < len; i++) {
      const item = arr[i]
      data[item[this.idKey]] = new DataWrap(this, item, this.idKey, i)
    }
    return data
  }
  /**
   * @description 设置单挑数据的数据
   * @param {String} id
   * @param {Object} data
   * @memberof CreateList
   */
  update (id, data) {
    const item = this.data[id]
    item.data = data
  }
  /**
   * @description 设置单条数据的Error
   * @param {String} id
   * @param {Error} error
   * @memberof CreateList
   */
  setError (id, error) {
    const item = this.data[id]
    item.error = error
  }
  /**
   * @description 改变单条数据的期望状态，重新进行定时更新
   * @param {String} id
   * @param {String | Array | Object} steadyStatus
   * @memberof CreateList
   */
  waitStatus (id, steadyStatus) {
    steadyStatus = this.genSteadyStatus(steadyStatus)
    const item = this.data[id]
    if (item.wait) {
      item.wait.status = steadyStatus
      item.wait.start()
    } else {
      item.waitStatus(steadyStatus)
    }
  }
  /**
   * @description 检查期望状态，是否需要轮询更新
   * @memberof CreateList
   */
  checkSteadyStatus () {
    if (
      (R.isNil(this.steadyStatus) || R.isEmpty(this.steadyStatus)) ||
      (R.isNil(this.data) || R.isEmpty(this.data))
    ) return
    for (let key in this.data) {
      const item = this.data[key]
      const isSteadyStatus = item.isSteadyStatus(this.steadyStatus)
      if (!isSteadyStatus) {
        item.waitStatus(this.steadyStatus)
      }
    }
  }
  /**
   * @description 清除轮询更新
   * @memberof CreateList
   */
  clearWaitJob () {
    if (
      (R.isNil(this.steadyStatus) || R.isEmpty(this.steadyStatus)) ||
      (R.isNil(this.data) || R.isEmpty(this.data))
    ) return
    for (let key in this.data) {
      const item = this.data[key]
      item.clearWaitJob()
    }
  }
  /**
   * @description 变更当前页
   * @param {Number} currentPage
   * @memberof CreateList
   */
  changeCurrentPage (currentPage) {
    const limit = this.getLimit()
    const offset = (currentPage - 1) * limit
    this.fetchData(offset, limit)
  }
  /**
   * @description 变更当前条数
   * @param {Number} pageSize
   * @memberof CreateList
   */
  changePageSize (pageSize) {
    storage.set(STORAGE_LIST_LIMIT_KEY, pageSize)
    const offset = Math.floor(this.offset / pageSize) * pageSize
    this.limit = pageSize
    this.fetchData(offset, pageSize)
  }
  /**
   * @description 过滤条件变更
   * @param {*} filter
   * @memberof CreateList
   */
  changeFilter (filter) {
    this.filter = filter
    this.reset()
    this.fetchData(0, 0)
  }
  /**
   * @description 勾选的数据发生改变事件
   *
   * @param {*} selection
   * @memberof CreateList
   */
  changeSelected (selection) {
    const ids = []
    for (let i = 0, len = selection.length; i < len; i++) {
      ids.push(selection[i][this.idKey])
    }
    this.selectedItems = selection
    this.selected = ids
  }
  /**
   * @description 清空勾选的数据
   * @memberof CreateList
   */
  clearSelected () {
    this.selectedItems = []
    this.selected = []
  }
  /**
   * @description 生成自定义filter的params
   *
   * @param {Object} params
   * @returns {Object}
   * @memberof CreateList
   */
  genFilterParams (params) {
    const ret = {}
    const filters = []
    // 查找已经存在的filter和自定义filter做合并
    for (let key in params) {
      if (key === 'filter') {
        filters.push(params[key])
      }
    }
    // 生成自定义过滤的params
    for (let key in this.filter) {
      const option = this.filterOptions[key]
      let val = this.filter[key]
      if (option.formatter) {
        val = option.formatter(val)
      }
      if (option.filter) {
        filters.push(val)
      } else {
        ret[key] = val
      }
    }
    if (filters.length > 0) {
      ret['filter'] = filters
    }
    return ret
  }
  /**
   * @description 是否允许删除
   **/
  allowDelete () {
    if (this.selectedItems.length <= 0) {
      return false
    }
    for (let i = 0, len = this.selectedItems.length; i < len; i++) {
      const { disable_delete: disableDelete, can_delete: canDelete } = this.selectedItems[i]
      if (R.is(Boolean, disableDelete) && disableDelete) {
        return false
      } else if (R.is(Boolean, canDelete) && !canDelete) {
        return false
      }
    }
    return true
  }
  /**
   * @description 对应 manager 里面的 performAction 方法
   *
   * @param {String} action
   * @param {Object} data
   * @param {Array} steadyStatus 期待状态
   * @returns Promise
   * @memberof CreateList
   */
  singlePerformAction (action, data, steadyStatus) {
    const id = data.id
    delete data.id
    return this.onManager('performAction', {
      id,
      steadyStatus,
      managerArgs: {
        action,
        data,
      },
    })
  }
  batchPerformAction (action, data, steadyStatus, selectedIds = this.selected) {
    if (steadyStatus) {
      for (let i = 0, len = selectedIds.length; i < len; i++) {
        let idstr = selectedIds[i]
        this.waitStatus(idstr, steadyStatus)
      }
    }
    return this.onManager('batchPerformAction', {
      id: selectedIds,
      steadyStatus,
      managerArgs: {
        action,
        data,
      },
    })
  }
  /**
   * @description 对应 manager 里面的 update 方法
   *
   * @param {String} id
   * @param {Object} data
   * @param {Array} steadyStatus 期待状态
   * @returns Promise
   * @memberof CreateList
   */
  singleUpdate (id, data, steadyStatus) {
    return this.onManager('update', {
      id,
      steadyStatus,
      managerArgs: {
        data,
      },
    })
  }
  batchUpdate (selectedIds = this.selected, data, steadyStatus) {
    if (steadyStatus) {
      for (let i = 0, len = selectedIds.length; i < len; i++) {
        let idstr = selectedIds[i]
        this.waitStatus(idstr, steadyStatus)
      }
    }
    return this.onManager('batchUpdate', {
      id: selectedIds,
      steadyStatus,
      managerArgs: {
        data,
      },
    })
  }
  /**
   * @description 调用manager方法的桥接方法，调用此方法可以同时更新 list 的对应数据
   * @param {String} on manager 的实例方法
   * @param {Object} opts
   * opts.expectStatus (String || Array || Object) 期望状态
   * opts.id (String || Array)
   * opts.managerArs (Array) 按照指定的 manager 实例方法所需参数顺序传入
   */
  onManager (on, opts) {
    if (!this.manager) return Promise.resolve()
    let {
      steadyStatus,
      id: ids = this.selected,
      managerArgs = {},
    } = opts
    const refreshActions = ['create', 'delete', 'batchDelete']
    if (R.is(String, ids)) {
      if (!managerArgs.id) managerArgs.id = ids
      ids = [ids]
    }
    if (R.is(Array, ids)) {
      if (!managerArgs.ids) managerArgs.ids = ids
    }
    if (!managerArgs) {
      throw Error('managerArgs 不能为空')
    }
    if (!R.is(Object, managerArgs)) {
      throw Error('managerArgs 须为对象，对应至manager的具体方法接受的参数')
    }
    const promise = this.manager[on]({ ...managerArgs }).then(res => {
      if (refreshActions.includes(on)) {
        this.refresh()
        return res
      }
      let isBatch = false
      if (R.is(Array, res.data.data)) {
        isBatch = true
      }
      if (on !== 'get') {
        if (isBatch) {
          for (let i = 0, len = res.data.data.length; i < len; i++) {
            let rec = res.data.data[i]
            if (rec.status < 400) {
              // success
              this.update(rec.id, rec.data)
            } else {
              // failure
              this.setError(rec.id, res)
            }
          }
        } else {
          if (res.status < 400) {
            this.update(ids[0], res.data)
          } else {
            this.setError(ids[0], res)
          }
        }
      }
      if (steadyStatus) {
        for (let i = 0, len = ids.length; i < len; i++) {
          let id = ids[i]
          this.waitStatus(id, steadyStatus)
        }
      }
      return res
    }).catch(err => {
      return Promise.reject(err)
    })
    return promise
  }
}

export default {
  createList (templateContext, options = {}) {
    return new CreateList(templateContext, options)
  },
}
